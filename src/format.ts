/** Mise en forme des matchs : événements de calendrier et textes de notification. */
import { DateTime } from "luxon";
import type { Match, TeamInfo } from "./model.js";

export const ZONE = "Europe/Paris";

export type EventPayload = {
  summary: string;
  location: string;
  description: string;
  url: string;
  startUtcIso: string; // début de l'événement (avant l'heure officielle)
  endUtcIso: string;
  officialStartUtcIso: string;
  alarmsUtcIso: string[];
};

/** Durée estimée d'un match selon son format (BO1 ≈ 1 h, BO3 ≈ 2 h 30, BO5 ≈ 4 h). */
export function estimatedDurationMinutes(bestOf?: number): number {
  switch (bestOf) {
    case 1:
      return 60;
    case 3:
      return 150;
    case 5:
      return 240;
    default:
      return 150;
  }
}

export function teamLabel(t: TeamInfo): string {
  // Nom complet si raisonnable, sinon le code (titres courts sur l'écran verrouillé).
  return t.name && t.name.length <= 20 ? t.name : t.code || t.name;
}

export function formatBo(bestOf?: number): string | undefined {
  return bestOf ? `BO${bestOf}` : undefined;
}

export function competitionLabel(m: Match): string {
  return [m.league, m.stage].filter(Boolean).join(" · ");
}

/** "ven. 16 janv. · 21:00" */
export function formatWhen(iso: string, opts: { withWeekday?: boolean } = {}): string {
  const d = DateTime.fromISO(iso, { zone: "utc" }).setZone(ZONE).setLocale("fr");
  const day = d.toFormat(opts.withWeekday === false ? "d LLL" : "ccc d LLL");
  return `${day} · ${d.toFormat("HH:mm")}`;
}

/** "Aujourd'hui", "Demain" ou la date. */
export function relativeDay(iso: string, now: DateTime = DateTime.now()): string {
  const d = DateTime.fromISO(iso, { zone: "utc" }).setZone(ZONE);
  const today = now.setZone(ZONE).startOf("day");
  const diff = Math.round(d.startOf("day").diff(today, "days").days);
  if (diff === 0) return `Aujourd'hui à ${d.toFormat("HH:mm")}`;
  if (diff === 1) return `Demain à ${d.toFormat("HH:mm")}`;
  return formatWhen(iso);
}

function recordLabel(t: TeamInfo): string | undefined {
  return t.record ? `${t.record.wins}V – ${t.record.losses}D` : undefined;
}

export function summaryFor(m: Match): string {
  const us = m.team.code || m.team.name;
  const them = teamLabel(m.opponent);
  if (m.status === "completed" && m.score) {
    const icon = m.outcome === "win" ? "✅" : m.outcome === "loss" ? "❌" : "🏁";
    return `${icon} ${us} ${m.score.team}–${m.score.opponent} ${them}`;
  }
  return `${us} vs ${them}`;
}

export function buildEventPayload(m: Match, cfg: { streamUrl: string; matchPageUrl: string; preMatchMinutes: number; postMatchMinutes: number }): EventPayload {
  const official = DateTime.fromISO(m.startUtcIso, { zone: "utc" });
  const start = official.minus({ minutes: cfg.preMatchMinutes });
  const end = official.plus({ minutes: estimatedDurationMinutes(m.bestOf) + cfg.postMatchMinutes });

  const bo = formatBo(m.bestOf);
  const location = [competitionLabel(m), bo].filter(Boolean).join(" · ");

  const lines: string[] = [];
  lines.push(`🏆 ${competitionLabel(m)}`);
  if (bo) lines.push(`🎯 Format : ${bo}`);
  lines.push(`🕗 Début officiel : ${formatWhen(m.startUtcIso)}`);
  const oppRecord = recordLabel(m.opponent);
  lines.push(`⚔️ Adversaire : ${m.opponent.name}${m.opponent.code && m.opponent.code !== m.opponent.name ? ` (${m.opponent.code})` : ""}${oppRecord ? ` — ${oppRecord}` : ""}`);
  const usRecord = recordLabel(m.team);
  if (usRecord) lines.push(`📊 Bilan ${m.team.code} : ${usRecord}`);
  if (m.status === "completed" && m.score) {
    const verdict = m.outcome === "win" ? "Victoire" : m.outcome === "loss" ? "Défaite" : "Terminé";
    lines.push(`🏁 Résultat : ${verdict} ${m.score.team}–${m.score.opponent}`);
  }
  lines.push("");
  lines.push(`📺 ${cfg.streamUrl}`);
  lines.push(`🔗 ${cfg.matchPageUrl}`);

  return {
    summary: summaryFor(m),
    location,
    description: lines.join("\n"),
    url: cfg.streamUrl,
    startUtcIso: start.toUTC().toISO()!,
    endUtcIso: end.toUTC().toISO()!,
    officialStartUtcIso: official.toUTC().toISO()!,
    // Rappels fixes (1 jour et 1 heure avant l'heure officielle) : ils ne dépendent plus
    // du jour d'exécution, donc plus de fausses "mises à jour" d'un jour sur l'autre.
    alarmsUtcIso: [official.minus({ days: 1 }), official.minus({ hours: 1 })].map((d) => d.toUTC().toISO()!),
  };
}
