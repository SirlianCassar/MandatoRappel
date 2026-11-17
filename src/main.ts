import fs from "node:fs";
import { DateTime } from "luxon";
import { readConfig, type Config } from "./config.js";
import { createAuthedFetch, deleteCalendarObject, discoverCalendars, listEvents, putCalendarObject } from "./caldav.js";
import { buildIcs } from "./ics.js";
import { createBackends, sendAll, type Notice } from "./notify/index.js";
import { getMatches, NeedsFallback } from "./sources/index.js";
import { FEED_PATH, readState, STATE_PATH, writeJson, type State } from "./state.js";
import { buildFeed, planSync } from "./sync.js";

function setOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${key}=${value.replace(/\r?\n/g, " ")}\n`);
}

function today(): string {
  return DateTime.now().setZone("Europe/Paris").toISODate()!;
}

function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0]!.slice(0, 300);
}

async function pickCalendar(cfg: Config, fetchFn: typeof fetch) {
  const calendars = await discoverCalendars(fetchFn);
  const usable = calendars.filter((c) => c.writable && c.supportsVevent);
  if (cfg.calendarName) {
    const wanted = cfg.calendarName.toLowerCase();
    const found = usable.find((c) => c.displayName.toLowerCase() === wanted);
    if (found) return found;
    const list = calendars.map((c) => `${c.displayName}${c.writable ? "" : " (lecture seule)"}`).join(", ");
    throw new Error(`Calendrier iCloud « ${cfg.calendarName} » introuvable ou non modifiable. Calendriers vus : ${list}`);
  }
  if (!usable[0]) throw new Error("Aucun calendrier iCloud modifiable trouvé.");
  return usable[0];
}

const V1_FILE = /\/evt-[0-9a-f]{16}\.ics$/;

/** Supprime les événements à venir créés par la v1 et remplacés par la v2 (même heure de match). */
async function migrateV1(fetchFn: typeof fetch, calendarUrl: string, state: State, now: DateTime): Promise<number> {
  const v2Starts = new Set(Object.values(state.events).map((e) => Date.parse(e.startUtcIso)));
  const objects = await listEvents({ fetchFn, calendarUrl, fromUtcIso: now.toUTC().toISO()!, toUtcIso: now.plus({ days: 365 }).toUTC().toISO()! });
  let removed = 0;
  for (const o of objects) {
    if (!V1_FILE.test(o.url) || !o.data.includes("PRODID:-//MandatoRappel//MDR Sync//FR")) continue;
    const m = o.data.match(/DTSTART[^:\r\n]*:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
    if (!m) continue;
    const dtstart = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    const official = dtstart + 30 * 60_000; // la v1 commençait l'événement 30 min avant le match
    if (!v2Starts.has(official)) continue;
    await deleteCalendarObject({ fetchFn, objectUrl: o.url });
    removed++;
  }
  return removed;
}

async function run(cfg: Config): Promise<void> {
  const now = DateTime.now().toUTC();
  const { state, fresh } = await readState();
  const backends = createBackends(cfg.notifyBackends);
  const notices: Notice[] = [];

  try {
    console.log(`[INFO] Récupération des matchs ${cfg.teamName} (source : ${cfg.source})`);
    const src = await getMatches(cfg);
    console.log(`[INFO] Source : ${src.source === "riot" ? "API officielle" : "scraping (secours)"} — ${src.matches.length} match(s) trouvé(s)`);
    for (const m of src.matches) {
      console.log(`  · ${m.startUtcIso} ${m.team.code} vs ${m.opponent.code} ${m.bestOf ? `BO${m.bestOf}` : ""} [${m.status}] ${m.league}${m.stage ? ` / ${m.stage}` : ""}`);
    }

    const plan = planSync({
      matches: src.matches,
      state,
      freshState: fresh,
      now,
      cfg,
      // Le scraping ne couvre pas forcément tout le calendrier : on ne supprime rien sur cette base.
      canDetectRemovals: src.source === "riot",
    });
    console.log(`[INFO] Plan : ${plan.stats.created} création(s), ${plan.stats.updated} mise(s) à jour, ${plan.stats.removed} suppression(s), ${plan.stats.unchanged} inchangé(s)`);

    if (src.source === "scrape" && state.health.lastFallbackNotifiedDay !== today()) {
      notices.push({
        kind: "fallback",
        title: "🛠️ Sync MDR : mode secours",
        body: `L'API officielle ne répond pas, le scraping a pris le relais.${src.fallbackReason ? `\n${src.fallbackReason.slice(0, 200)}` : ""}`,
        url: cfg.runUrl,
        priority: "low",
      });
      plan.nextState.health.lastFallbackNotifiedDay = today();
    }

    if (cfg.dryRun) {
      for (const a of plan.actions) console.log(`[DRY_RUN] ${a.type} ${a.uid}${a.type === "put" ? ` « ${a.payload.summary} »` : ""}`);
      await sendAll(backends, [...plan.notices, ...notices], { dryRun: true });
      console.log("[INFO] DRY_RUN : rien n'a été écrit sur iCloud ni dans l'état.");
      return;
    }

    const nextState = plan.nextState;
    const failures: string[] = [];
    let calendarUrl: string | undefined;
    const fetchFn = createAuthedFetch(cfg.icloudUsername, cfg.icloudAppPassword);

    if (plan.actions.length > 0 || !state.migratedV1) {
      const cal = await pickCalendar(cfg, fetchFn);
      calendarUrl = cal.url;
      console.log(`[INFO] Calendrier : ${cal.displayName}`);
    }

    const dtstamp = new Date().toISOString();
    for (const a of plan.actions) {
      const objectUrl = new URL(`${a.uid}.ics`, calendarUrl).toString();
      try {
        if (a.type === "put") {
          await putCalendarObject({ fetchFn, objectUrl, ics: buildIcs({ uid: a.uid, dtstampUtcIso: dtstamp, payload: a.payload }), createOnly: false });
          console.log(`[OK] ${a.isNew ? "Créé" : "Mis à jour"} : ${a.payload.summary}`);
        } else {
          await deleteCalendarObject({ fetchFn, objectUrl });
          console.log(`[OK] Supprimé : ${a.uid}`);
        }
      } catch (e) {
        failures.push(`${a.uid} : ${shortError(e)}`);
        // On garde l'ancien état pour ce match : il sera retenté au prochain run.
        if (state.events[a.uid]) nextState.events[a.uid] = state.events[a.uid]!;
        else delete nextState.events[a.uid];
      }
    }

    if (!state.migratedV1 && calendarUrl && failures.length === 0) {
      try {
        const n = await migrateV1(fetchFn, calendarUrl, nextState, now);
        if (n > 0) console.log(`[INFO] Migration : ${n} ancien(s) événement(s) v1 remplacé(s) supprimé(s).`);
        nextState.migratedV1 = true;
      } catch (e) {
        console.warn(`[WARN] Migration v1 non effectuée (sera retentée) : ${shortError(e)}`);
      }
    }

    // Ne pas annoncer un changement qui n'a pas pu être écrit.
    const failedUids = new Set(failures.map((f) => f.split(" : ")[0]));
    const okNotices = failures.length === 0 ? plan.notices : plan.notices.filter((n) => !n.match || ![...failedUids].some((u) => u?.includes(String(n.match?.id))));

    if (failures.length > 0) throw Object.assign(new Error(`${failures.length} écriture(s) iCloud en échec :\n${failures.join("\n")}`), { partialState: nextState, partialNotices: okNotices });

    nextState.health.consecutiveFailures = 0;
    await sendAll(backends, [...okNotices, ...notices]);
    await writeJson(STATE_PATH, nextState);
    await writeJson(FEED_PATH, buildFeed(src.matches, now));
    console.log("[INFO] Synchronisation terminée.");
  } catch (e) {
    if (e instanceof NeedsFallback) {
      setOutput("needs_fallback", "true");
      setOutput("fallback_reason", e.reason.slice(0, 200));
      console.log("[INFO] Bascule vers le scraping de secours demandée au workflow.");
      return;
    }
    const partial: State = (e as any)?.partialState ?? state;
    const partialNotices: Notice[] = (e as any)?.partialNotices ?? [];
    partial.health.consecutiveFailures = (state.health.consecutiveFailures ?? 0) + 1;
    const toSend = [...partialNotices];
    if (partial.health.lastFailureNotifiedDay !== today()) {
      toSend.push({
        kind: "error",
        title: "⚠️ Sync MDR en échec",
        body: `${shortError(e)}${partial.health.consecutiveFailures > 1 ? `\n(${partial.health.consecutiveFailures} échecs d'affilée)` : ""}`,
        url: cfg.runUrl,
        priority: "high",
      });
      partial.health.lastFailureNotifiedDay = today();
      setOutput("failure_notified", "true");
    } else {
      setOutput("failure_notified", "true"); // déjà signalé aujourd'hui
    }
    if (!cfg.dryRun) {
      await sendAll(backends, toSend);
      await writeJson(STATE_PATH, partial);
    }
    throw e;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--test-notification") || args.has("--notify-workflow-failure")) {
    const cfg = readConfig(process.env, { requireIcloud: false });
    const backends = createBackends(cfg.notifyBackends);
    if (backends.length === 0) throw new Error("Aucun service de notification configuré (NOTIFY_BACKENDS).");
    const notice: Notice = args.has("--test-notification")
      ? { kind: "test", title: "✅ Notifications MDR opérationnelles", body: `Services actifs : ${backends.map((b) => b.name).join(", ")}`, url: cfg.streamUrl, priority: "default" }
      : { kind: "error", title: "⚠️ Workflow MDR en échec", body: "Le workflow a échoué avant la synchronisation (installation, réseau…). Voir les logs.", url: cfg.runUrl, priority: "high" };
    await sendAll(backends, [notice]);
    return;
  }

  await run(readConfig());
}

main().catch((err) => {
  console.error("[FATAL]", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
