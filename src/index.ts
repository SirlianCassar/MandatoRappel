import { DateTime } from "luxon";
import { readEnv } from "./env.js";
import { discoverCalendars, createAuthedFetch, putCalendarObject } from "./caldav.js";
import { buildIcs } from "./ics.js";
import { readState, writeState } from "./state.js";
import type { MatchPayload, ScrapedMatch, StateV1 } from "./types.js";
import { deepEqual, nowUtcIso, stableEventKeyFromSource, stableMatchId } from "./util.js";
import { scrapeMdrMatches } from "./scrape.js";

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
}): Promise<{ href: string; etag?: string; didChange: boolean }> {
  const objectUrl = new URL(`${params.eventKey}.ics`, params.calendarUrl).toString();
  const uid = params.uid;
  const dtstampUtcIso = nowUtcIso();

  const keepMinus1DayAlarm = params.payload.alarms.minus1Day;
  const ics = buildIcs({ uid, dtstampUtcIso, payload: params.payload, keepMinus1DayAlarm });

  if (params.dryRun) {
    return { href: objectUrl, etag: params.existingState?.etag, didChange: true };
  }

  if (!params.existingState) {
    const { etag } = await putCalendarObject({
      fetchFn: params.fetchFn,
      objectUrl,
      ics,
      createOnly: true,
    });
    return { href: objectUrl, etag, didChange: true };
  }

  // Update (PUT) si payload a changé
  if (deepEqual(params.existingState.payload, params.payload)) {
    return { href: objectUrl, etag: params.existingState.etag, didChange: false };
  }

  const { etag } = await putCalendarObject({
    fetchFn: params.fetchFn,
    objectUrl,
    ics,
    etag: params.existingState.etag,
    createOnly: false,
  });

  return { href: objectUrl, etag, didChange: true };
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
  const scraped = await scrapeMdrMatches({ teamName });
  console.log(`[INFO] Matchs bruts récupérés: ${scraped.length}`);

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
    const eventKey = indexed?.eventKey ?? computedEventKey;

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

    if (!existing) created += 1;
    else if (result.didChange) updated += 1;
    else unchanged += 1;

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

  await writeState(state);
  console.log(`[INFO] Sync terminé. Créés=${created} / MAJ=${updated} / Inchangés=${unchanged}`);

  if (env.dryRun) {
    console.log("[INFO] DRY_RUN actif: aucune écriture CalDAV, mais état local mis à jour.");
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exitCode = 1;
});


