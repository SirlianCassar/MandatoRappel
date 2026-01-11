import { DateTime } from "luxon";
import { readEnv } from "./env.js";
import {
  discoverCalendars,
  createAuthedFetch,
  putCalendarObject,
  deleteCalendarObject,
  getCalendarObjectMeta,
} from "./caldav.js";
import { buildIcs } from "./ics.js";
import { readState, writeState } from "./state.js";
import type { MatchPayload, ScrapedMatch, StateV1 } from "./types.js";
import { deepEqual, nowUtcIso, stableEventKeyFromSource, stableMatchId } from "./util.js";
import { scrapeMdrMatches } from "./scrape.js";
import { scrapeLiquipediaUpcomingMatches } from "./liquipedia.js";

function mustRunNowParis13h(forceRun: boolean): boolean {
  if (forceRun) return true;
  // GitHub cron est en UTC, donc on "gate" en runtime pour être exact à 13h Europe/Paris (DST inclus)
  if (!process.env.GITHUB_ACTIONS) return true;
  const nowParis = DateTime.now().setZone("Europe/Paris");
  return nowParis.hour === 13;
}

function buildPayload(match: ScrapedMatch, teamName: string, nowUtc: DateTime, existing?: MatchPayload): MatchPayload {
  const start = DateTime.fromISO(match.startUtcIso, { zone: "utc" });
  const end = start.plus({ hours: 2 }); // durée par défaut

  const summary = `${teamName} VS ${match.opponentName}`.trim();

  const bestOfClean = match.bestOf?.trim();
  const location = bestOfClean ? `${bestOfClean} — ${match.tournamentName}` : match.tournamentName;

  const description = "https://www.twitch.tv/zerator\nhttps://valorantesports.com/fr-FR/";

  // Alarmes:
  // - 1h toujours
  // - 1j si: déjà présent OU si l'ajout/maj se fait >= 48h avant le start
  const isAtLeast48hBefore = start.diff(nowUtc, "hours").hours >= 48;
  const minus1Day = existing?.alarms.minus1Day === true || isAtLeast48hBefore;

  return {
    summary,
    location,
    description,
    startUtcIso: start.toUTC().toISO()!,
    endUtcIso: end.toUTC().toISO()!,
    alarms: {
      minus1Hour: true,
      minus1Day,
    },
  };
}

async function syncOne(params: {
  fetchFn: typeof fetch;
  calendarUrl: string;
  eventKey: string;
  uid: string;
  payload: MatchPayload;
  existingState?: StateV1["events"][string];
  dryRun: boolean;
}): Promise<{ href: string; etag?: string; didChange: boolean; didCreateOnServer: boolean }> {
  const objectUrl = new URL(`${params.eventKey}.ics`, params.calendarUrl).toString();
  const uid = params.uid;
  const dtstampUtcIso = nowUtcIso();

  const keepMinus1DayAlarm = params.payload.alarms.minus1Day;
  const ics = buildIcs({ uid, dtstampUtcIso, payload: params.payload, keepMinus1DayAlarm });

  if (params.dryRun) {
    const didChange = !params.existingState || !deepEqual(params.existingState.payload, params.payload);
    return { href: objectUrl, etag: params.existingState?.etag, didChange, didCreateOnServer: !params.existingState };
  }

  if (!params.existingState) {
    const { etag } = await putCalendarObject({
      fetchFn: params.fetchFn,
      objectUrl,
      ics,
      createOnly: true,
    });
    return { href: objectUrl, etag, didChange: true, didCreateOnServer: true };
  }

  // Vérifier que l'objet existe réellement côté iCloud.
  // Important: avant, on persistait l'état en DRY_RUN, ce qui pouvait "inventer" des events inexistants.
  const meta = await getCalendarObjectMeta({ fetchFn: params.fetchFn, objectUrl });
  if (!meta.exists) {
    const { etag } = await putCalendarObject({
      fetchFn: params.fetchFn,
      objectUrl,
      ics,
      createOnly: true,
    });
    return { href: objectUrl, etag, didChange: true, didCreateOnServer: true };
  }

  // Update (PUT) si payload a changé
  if (deepEqual(params.existingState.payload, params.payload)) {
    // Profiter du HEAD/GET pour récupérer un ETag manquant.
    return { href: objectUrl, etag: meta.etag ?? params.existingState.etag, didChange: false, didCreateOnServer: false };
  }

  const etagForUpdate = params.existingState.etag ?? meta.etag;
  const { etag } = await putCalendarObject({
    fetchFn: params.fetchFn,
    objectUrl,
    ics,
    etag: etagForUpdate,
    createOnly: false,
  });

  return { href: objectUrl, etag, didChange: true, didCreateOnServer: false };
}

export async function main(): Promise<void> {
  const env = readEnv();

  if (!mustRunNowParis13h(env.forceRun)) {
    console.log("[INFO] Hors fenêtre 13h Europe/Paris (gating DST). Sortie sans erreur.");
    return;
  }

  const nowUtc = DateTime.now().toUTC();
  const teamName = env.TEAM_NAME.trim();

  const state = await readState();

  console.log(`[INFO] Scraping des matchs pour l'équipe: ${teamName}`);
  const official = await scrapeMdrMatches({ teamName });
  let scraped = official;

  if (env.useLiquipedia) {
    try {
      const liq = await scrapeLiquipediaUpcomingMatches({
        teamCode: teamName,
        url: env.LIQUIPEDIA_URL,
      });
      // Merge: l'officiel est prioritaire.
      // Si un match officiel existe déjà au même horaire, on ignore Liquipedia (évite les doublons
      // en cas de divergences d'acronymes adverses: ex CAL vs CLA).
      const officialByStart = new Map<string, ScrapedMatch>();
      for (const m of official) officialByStart.set(m.startUtcIso, m);

      const extra = liq.filter((m) => {
        const off = officialByStart.get(m.startUtcIso);
        if (!off) return true;
        if (off.opponentName !== m.opponentName) {
          console.warn(
            `[WARN] Conflit Liquipedia ignoré (officiel prioritaire): ${m.startUtcIso} officiel=${off.opponentName} liquipedia=${m.opponentName}`
          );
        }
        return false;
      });
      if (extra.length > 0) {
        console.log(`[INFO] Liquipedia: +${extra.length} matchs ajoutés (complément de l'officiel).`);
      }
      scraped = official.concat(extra);
    } catch (e) {
      console.warn(`[WARN] Liquipedia désactivé (erreur): ${String(e)}`);
    }
  }
  console.log(`[INFO] Matchs bruts récupérés: ${scraped.length}`);

  // Migration: si un même eventKey est référencé par plusieurs matchId,
  // c'est typiquement un ancien état (bug: sourceUrl identique) -> on purge cet event.
  const eventKeyCounts = new Map<string, number>();
  for (const v of Object.values(state.matchIdIndex)) {
    eventKeyCounts.set(v.eventKey, (eventKeyCounts.get(v.eventKey) ?? 0) + 1);
  }
  const corruptedEventKeys = new Set<string>();
  for (const [k, c] of eventKeyCounts.entries()) {
    if (c > 1) corruptedEventKeys.add(k);
  }
  if (corruptedEventKeys.size > 0) {
    console.warn(
      `[WARN] État détecté comme corrompu (eventKey partagé): ${Array.from(corruptedEventKeys).join(", ")}`
    );
  }

  // Filtrage règles métier (redondant par sécurité)
  const valid: ScrapedMatch[] = scraped.filter((m) => {
    if (m.teamName.trim().toLowerCase() !== teamName.toLowerCase()) return false;
    if (!m.opponentName || m.opponentName.trim().length === 0) return false;
    if (m.opponentName.trim().toLowerCase() === "tbd") return false;
    if (!m.startUtcIso) return false;
    if (!m.tournamentName || m.tournamentName.trim().length === 0) return false;
    return true;
  });

  console.log(`[INFO] Matchs MDR complets détectés: ${valid.length}`);
  if (env.debugScrape && scraped.length > 0) {
    for (const m of scraped.slice(0, 5)) {
      console.log(
        `[DEBUG] ${m.startUtcIso} | ${m.teamName} vs ${m.opponentName} | ${m.bestOf ?? "BO?"} | ${m.tournamentName}`
      );
    }
  }

  if (valid.length === 0) return;

  const fetchFn = createAuthedFetch(env.ICLOUD_USERNAME, env.ICLOUD_APP_PASSWORD);
  const calendars = await discoverCalendars(fetchFn);
  const chosen =
    (env.ICLOUD_CALENDAR_NAME
      ? calendars.find((c) => c.displayName.toLowerCase() === env.ICLOUD_CALENDAR_NAME!.toLowerCase())
      : undefined) ?? calendars[0];

  console.log(`[INFO] Calendrier iCloud sélectionné: ${chosen.displayName}`);

  // Si on a détecté des events corrompus, on les supprime une fois (hors DRY_RUN).
  if (!env.dryRun && corruptedEventKeys.size > 0) {
    for (const k of corruptedEventKeys) {
      const existing = state.events[k];
      if (!existing) continue;
      try {
        await deleteCalendarObject({ fetchFn, objectUrl: existing.href, etag: existing.etag });
        console.log(`[INFO] Suppression d'un ancien event corrompu: ${k}`);
      } catch (e) {
        console.warn(`[WARN] Suppression impossible pour ${k}: ${String(e)}`);
      }
      // Nettoyage état local
      delete state.events[k];
    }
    for (const [mid, v] of Object.entries(state.matchIdIndex)) {
      if (corruptedEventKeys.has(v.eventKey)) delete state.matchIdIndex[mid];
    }
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const m of valid) {
    const matchId = stableMatchId({
      startUtcIso: m.startUtcIso,
      teamName,
      opponentName: m.opponentName,
      tournamentName: m.tournamentName,
    });

    // eventKey/UID stables pour permettre les mises à jour quand la date/heure/tournoi bougent.
    const computedEventKey = stableEventKeyFromSource(m.sourceUrl, matchId);

    // Si on a déjà vu ce matchId exact (anti-doublon), on retrouve l'eventKey via l'index.
    const indexed = state.matchIdIndex[matchId];
    const eventKey = indexed?.eventKey && !corruptedEventKeys.has(indexed.eventKey) ? indexed.eventKey : computedEventKey;

    const existing = state.events[eventKey];
    const uid = existing?.uid ?? eventKey;
    const payload = buildPayload(m, teamName, nowUtc, existing?.payload);

    const result = await syncOne({
      fetchFn,
      calendarUrl: chosen.url,
      eventKey,
      uid,
      payload,
      existingState: existing,
      dryRun: env.dryRun,
    });

    if (result.didCreateOnServer) created += 1;
    else if (result.didChange) updated += 1;
    else unchanged += 1;

    if (!env.dryRun) {
      // Mise à jour index anti-doublon: si l'événement existait et que matchId a changé, on supprime l'ancien.
      if (existing && existing.matchId !== matchId) {
        delete state.matchIdIndex[existing.matchId];
      }
      state.matchIdIndex[matchId] = { eventKey, lastSeenUtcIso: nowUtcIso() };

      state.events[eventKey] = {
        href: result.href,
        etag: result.etag ?? existing?.etag,
        uid,
        matchId,
        payload,
        lastSeenUtcIso: nowUtcIso(),
      };
    }
  }

  console.log(`[INFO] Sync terminé. Créés=${created} / MAJ=${updated} / Inchangés=${unchanged}`);

  if (env.dryRun) {
    console.log("[INFO] DRY_RUN actif: aucune écriture CalDAV, état local inchangé.");
    return;
  }

  await writeState(state);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exitCode = 1;
});


