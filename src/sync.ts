/**
 * Cœur de la synchronisation.
 * `planSync` est pure (testable) : à partir des matchs, de l'état et de l'heure,
 * elle décide quoi écrire/supprimer sur iCloud et quoi notifier.
 */
import crypto from "node:crypto";
import { DateTime } from "luxon";
import type { Config } from "./config.js";
import type { Match } from "./model.js";
import { norm } from "./model.js";
import { buildEventPayload, competitionLabel, formatBo, formatWhen, relativeDay, teamLabel, type EventPayload } from "./format.js";
import type { State, TrackedEvent } from "./state.js";
import { stableStringify } from "./state.js";
import type { Notice } from "./notify/types.js";

export type Action =
  | { type: "put"; uid: string; payload: EventPayload; isNew: boolean }
  | { type: "delete"; uid: string };

export type Plan = {
  actions: Action[];
  notices: Notice[];
  nextState: State;
  stats: { created: number; updated: number; removed: number; unchanged: number };
};

const PAST_GRACE_HOURS = 12; // un match "à venir" plus vieux que ça est ignoré
const KEEP_PAST_DAYS = 7; // on garde les matchs passés en mémoire une semaine (pour les résultats)

export function uidFor(matchId: string): string {
  const safe = matchId.replace(/[^A-Za-z0-9_-]/g, "");
  return `mdr2-${safe || crypto.createHash("sha256").update(matchId).digest("hex").slice(0, 16)}`;
}

function hashPayload(p: EventPayload): string {
  return crypto.createHash("sha256").update(stableStringify(p)).digest("hex").slice(0, 16);
}

/** Retrouve l'événement déjà suivi pour ce match (même id, ou même heure + même adversaire si la source a changé). */
function resolveUid(m: Match, events: Record<string, TrackedEvent>): string {
  const direct = uidFor(m.id);
  if (events[direct]) return direct;
  const opp = [norm(m.opponent.name), norm(m.opponent.code)];
  for (const [uid, ev] of Object.entries(events)) {
    if (ev.startUtcIso === m.startUtcIso && opp.includes(norm(ev.opponent))) return uid;
  }
  return direct;
}

function matchData(m: Match) {
  return {
    id: m.id,
    start: m.startUtcIso,
    opponent: m.opponent.name,
    opponentCode: m.opponent.code,
    bestOf: m.bestOf ?? null,
    competition: competitionLabel(m),
    status: m.status,
    score: m.score ?? null,
    outcome: m.outcome ?? null,
  };
}

function headline(m: Match): string {
  return [formatWhen(m.startUtcIso), formatBo(m.bestOf)].filter(Boolean).join(" · ");
}

export function planSync(params: {
  matches: Match[];
  state: State;
  freshState: boolean;
  now: DateTime;
  cfg: Pick<Config, "streamUrl" | "matchPageUrl" | "preMatchMinutes" | "postMatchMinutes" | "notifyResults" | "removeAfterMissingRuns" | "teamName">;
  /** false si la liste de matchs n'est pas fiable pour détecter les retraits (ex. scraping de secours). */
  canDetectRemovals: boolean;
}): Plan {
  const { matches, state, now, cfg } = params;
  const events: Record<string, TrackedEvent> = structuredClone(state.events);
  const actions: Action[] = [];
  const notices: Notice[] = [];
  const newOnes: Match[] = [];
  const seen = new Set<string>();
  const stats = { created: 0, updated: 0, removed: 0, unchanged: 0 };
  const nowMs = now.toMillis();

  for (const m of [...matches].sort((a, b) => a.startUtcIso.localeCompare(b.startUtcIso))) {
    const startMs = Date.parse(m.startUtcIso);
    const uid = resolveUid(m, events);
    const existing = events[uid];

    // On ne crée jamais d'événement pour un match déjà joué ou périmé.
    if (!existing && (m.status === "completed" || startMs < nowMs - PAST_GRACE_HOURS * 3600_000)) continue;
    seen.add(uid);

    const payload = buildEventPayload(m, cfg);
    const hash = hashPayload(payload);
    const tracked: TrackedEvent = {
      matchId: m.id,
      hash,
      startUtcIso: m.startUtcIso,
      summary: payload.summary,
      opponent: m.opponent.code || m.opponent.name,
      status: m.status,
      resultNotified: existing?.resultNotified,
      missingRuns: 0,
    };

    if (!existing) {
      actions.push({ type: "put", uid, payload, isNew: true });
      stats.created++;
      newOnes.push(m);
      events[uid] = tracked;
      continue;
    }

    if (existing.hash === hash) {
      stats.unchanged++;
      events[uid] = tracked;
      continue;
    }

    actions.push({ type: "put", uid, payload, isNew: false });
    stats.updated++;
    const url = cfg.streamUrl;
    const vs = `${cfg.teamName} vs ${teamLabel(m.opponent)}`;

    if (existing.startUtcIso !== m.startUtcIso && m.status === "upcoming") {
      notices.push({
        kind: "rescheduled",
        title: `🕒 Match déplacé : ${vs}`,
        body: `${formatWhen(existing.startUtcIso)} → ${formatWhen(m.startUtcIso)}\n${competitionLabel(m)}`,
        url,
        priority: "high",
        match: matchData(m),
      });
    } else if (m.status === "completed" && m.score && !existing.resultNotified) {
      if (cfg.notifyResults) {
        const win = m.outcome === "win";
        notices.push({
          kind: "result",
          title: `${win ? "✅ Victoire" : m.outcome === "loss" ? "❌ Défaite" : "🏁 Fin du match"} ${m.score.team}–${m.score.opponent} contre ${teamLabel(m.opponent)}`,
          body: competitionLabel(m),
          url: cfg.matchPageUrl,
          priority: "default",
          match: matchData(m),
        });
      }
      tracked.resultNotified = true;
    } else if (norm(existing.opponent) !== norm(m.opponent.code || m.opponent.name)) {
      notices.push({
        kind: "updated",
        title: `✏️ Match modifié : ${vs}`,
        body: `${headline(m)}\n${competitionLabel(m)}`,
        url,
        priority: "default",
        match: matchData(m),
      });
    }
    events[uid] = tracked;
  }

  // Événements suivis qui n'apparaissent plus dans la source.
  for (const [uid, ev] of Object.entries(events)) {
    if (seen.has(uid)) continue;
    const startMs = Date.parse(ev.startUtcIso);
    if (startMs < nowMs - KEEP_PAST_DAYS * 86400_000) {
      delete events[uid]; // match ancien : on l'oublie (il reste dans le calendrier)
      continue;
    }
    if (startMs <= nowMs || !params.canDetectRemovals) continue;
    const missing = (ev.missingRuns ?? 0) + 1;
    if (missing >= cfg.removeAfterMissingRuns) {
      actions.push({ type: "delete", uid });
      stats.removed++;
      notices.push({
        kind: "removed",
        title: `🗑️ Match retiré du planning : ${ev.summary}`,
        body: `Prévu ${formatWhen(ev.startUtcIso)}. Supprimé du calendrier.`,
        url: cfg.matchPageUrl,
        priority: "default",
      });
      delete events[uid];
    } else {
      events[uid] = { ...ev, missingRuns: missing };
    }
  }

  // Nouveaux matchs : une notif par match, ou un récapitulatif s'il y en a beaucoup (ou au premier lancement).
  if (newOnes.length > 0) {
    if (params.freshState || newOnes.length > 3) {
      notices.unshift({
        kind: "digest",
        title: params.freshState ? `📅 Calendrier MDR initialisé (${newOnes.length} match${newOnes.length > 1 ? "s" : ""})` : `📅 ${newOnes.length} nouveaux matchs MDR`,
        body: newOnes.map((m) => `• ${formatWhen(m.startUtcIso)} — vs ${teamLabel(m.opponent)}${m.bestOf ? ` (BO${m.bestOf})` : ""}`).join("\n"),
        url: cfg.streamUrl,
        priority: "default",
      });
    } else {
      for (const m of newOnes) {
        notices.unshift({
          kind: "new",
          title: `🆕 ${cfg.teamName} vs ${teamLabel(m.opponent)}`,
          body: `${relativeDay(m.startUtcIso, now)}${m.bestOf ? ` · BO${m.bestOf}` : ""}\n${competitionLabel(m)}`,
          url: cfg.streamUrl,
          priority: "default",
          match: matchData(m),
        });
      }
    }
  }

  return { actions, notices, nextState: { ...state, events }, stats };
}

/** Flux JSON des prochains matchs (pour Raccourcis / widgets). Déterministe. */
export function buildFeed(matches: Match[], now: DateTime) {
  const upcoming = matches
    .filter((m) => m.status !== "completed" && Date.parse(m.startUtcIso) > now.toMillis() - 4 * 3600_000)
    .sort((a, b) => a.startUtcIso.localeCompare(b.startUtcIso))
    .map((m) => ({
      ...matchData(m),
      startParis: DateTime.fromISO(m.startUtcIso).setZone("Europe/Paris").toISO(),
      label: `${m.team.code} vs ${teamLabel(m.opponent)}`,
      when: formatWhen(m.startUtcIso),
    }));
  const results = matches
    .filter((m) => m.status === "completed")
    .sort((a, b) => b.startUtcIso.localeCompare(a.startUtcIso))
    .slice(0, 5)
    .map(matchData);
  return { next: upcoming[0] ?? null, upcoming, results };
}
