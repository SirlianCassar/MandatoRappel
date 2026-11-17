/**
 * Source principale : l'API JSON qu'utilise valorantesports.com pour afficher son planning.
 * Pas de navigateur : de simples requêtes HTTP, rapides et peu fragiles.
 *
 * L'API n'est pas documentée publiquement : tout est parsé de manière défensive,
 * et la moindre incohérence lève une erreur pour basculer sur le scraping de secours.
 */
import type { Match, MatchStatus, TeamInfo } from "../model.js";
import { isUnknownTeam, norm } from "../model.js";

const API_BASE = process.env.RIOT_ESPORTS_API_BASE?.trim() || "https://esports-api.service.valorantesports.com/persisted/val";
// Clé publique embarquée dans le site (identique pour tous les visiteurs).
const API_KEY = process.env.RIOT_ESPORTS_API_KEY?.trim() || "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";
const HL = "fr-FR";

type FetchLike = typeof fetch;

export class SourceError extends Error {}

async function getJson(fetchFn: FetchLike, path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchFn(url, {
        headers: { "x-api-key": API_KEY, Accept: "application/json", "User-Agent": "MandatoRappel/2.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new SourceError(`${path} → HTTP ${res.status} ${body.slice(0, 200)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      // 4xx (hors 429) : inutile de réessayer
      if (e instanceof SourceError && /HTTP 4(?!29)/.test(e.message)) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new SourceError(String(lastErr));
}

export type RiotLeague = { id: string; name: string; slug: string; region?: string };

export async function fetchLeagues(fetchFn: FetchLike): Promise<RiotLeague[]> {
  const json = await getJson(fetchFn, "getLeagues", { hl: HL });
  const leagues = json?.data?.leagues;
  if (!Array.isArray(leagues)) throw new SourceError("getLeagues : format inattendu (data.leagues absent)");
  return leagues
    .filter((l: any) => l && l.id)
    .map((l: any) => ({ id: String(l.id), name: String(l.name ?? ""), slug: String(l.slug ?? ""), region: l.region }));
}

/** Trouve les ligues dont le nom ou le slug contient tous les mots du motif ("Challengers France"). */
export function pickLeagues(all: RiotLeague[], patterns: string[]): RiotLeague[] {
  const picked = new Map<string, RiotLeague>();
  for (const p of patterns) {
    const words = norm(p).split(" ").filter(Boolean);
    for (const l of all) {
      const hay = `${norm(l.name)} ${norm(l.slug)}`;
      if (words.every((w) => hay.includes(w))) picked.set(l.id, l);
    }
  }
  return [...picked.values()];
}

function mapStatus(state: unknown): MatchStatus {
  const s = String(state ?? "").toLowerCase();
  if (s === "completed") return "completed";
  if (s === "inprogress" || s === "in_progress" || s === "live") return "live";
  return "upcoming";
}

function mapTeam(t: any): TeamInfo {
  const record =
    t?.record && Number.isFinite(t.record.wins) && Number.isFinite(t.record.losses)
      ? { wins: Number(t.record.wins), losses: Number(t.record.losses) }
      : undefined;
  const name = String(t?.name ?? "").trim();
  const code = String(t?.code ?? "").trim();
  return { name: name || code, code: code || name, record };
}

export function teamMatches(t: TeamInfo, teamName: string, aliases: string[]): boolean {
  const wanted = [teamName, ...aliases].map(norm).filter(Boolean);
  return wanted.includes(norm(t.code)) || wanted.includes(norm(t.name));
}

/** Convertit un événement brut de getSchedule en Match (ou null si non pertinent). */
export function eventToMatch(ev: any, opts: { teamName: string; aliases: string[] }): Match | null {
  if (!ev || (ev.type && ev.type !== "match")) return null;
  const m = ev.match;
  const teamsRaw: any[] = Array.isArray(m?.teams) ? m.teams : [];
  if (teamsRaw.length !== 2) return null;
  const startUtc = ev.startTime ? new Date(ev.startTime) : null;
  if (!startUtc || Number.isNaN(startUtc.getTime())) return null;

  const teams = teamsRaw.map(mapTeam);
  const idx = teams.findIndex((t) => teamMatches(t, opts.teamName, opts.aliases));
  if (idx === -1) return null;
  const team = teams[idx]!;
  const opponent = teams[1 - idx]!;
  if (isUnknownTeam(opponent)) return null;

  const leagueName = String(ev.league?.name ?? "").trim();
  if (!leagueName) return null;

  const status = mapStatus(ev.state);
  const usRes = teamsRaw[idx]?.result;
  const themRes = teamsRaw[1 - idx]?.result;
  const hasScore = Number.isFinite(usRes?.gameWins) && Number.isFinite(themRes?.gameWins);
  const score = hasScore && status !== "upcoming" ? { team: Number(usRes.gameWins), opponent: Number(themRes.gameWins) } : undefined;
  let outcome: Match["outcome"];
  if (status === "completed") {
    const o = String(usRes?.outcome ?? "").toLowerCase();
    if (o === "win" || o === "loss") outcome = o;
    else if (score) outcome = score.team > score.opponent ? "win" : score.team < score.opponent ? "loss" : undefined;
  }

  const count = Number(m?.strategy?.count);
  const bestOf = String(m?.strategy?.type ?? "bestOf") === "bestOf" && Number.isFinite(count) && count > 0 ? count : undefined;

  const id = String(m?.id ?? ev.id ?? "").trim();
  if (!id) return null;

  return {
    id,
    source: "riot",
    startUtcIso: startUtc.toISOString(),
    status,
    bestOf,
    league: leagueName,
    stage: String(ev.blockName ?? "").trim() || undefined,
    team: { ...team, code: team.code || opts.teamName },
    opponent,
    score,
    outcome,
  };
}

export async function fetchRiotMatches(params: {
  teamName: string;
  aliases: string[];
  leagues: string[];
  leagueIds: string[];
  debug?: boolean;
  fetchFn?: FetchLike;
  /** Nombre de pages "futures" à suivre au-delà de la page courante. */
  maxNewerPages?: number;
}): Promise<{ matches: Match[]; leagueNames: string[] }> {
  const fetchFn = params.fetchFn ?? fetch;

  let leagueIds = params.leagueIds;
  let leagueNames: string[] = [];
  if (leagueIds.length === 0) {
    const all = await fetchLeagues(fetchFn);
    const picked = pickLeagues(all, params.leagues);
    if (picked.length === 0) {
      const sample = all.slice(0, 40).map((l) => l.name).join(", ");
      throw new SourceError(`Aucune ligue ne correspond à "${params.leagues.join(", ")}". Ligues vues : ${sample}`);
    }
    leagueIds = picked.map((l) => l.id);
    leagueNames = picked.map((l) => l.name);
  }
  if (params.debug) console.log(`[DEBUG] Ligues suivies : ${leagueNames.join(", ") || leagueIds.join(", ")}`);

  const events: any[] = [];
  const base = { hl: HL, leagueId: leagueIds.join(",") };
  const first = await getJson(fetchFn, "getSchedule", base);
  const schedule = first?.data?.schedule;
  if (!schedule || !Array.isArray(schedule.events)) throw new SourceError("getSchedule : format inattendu (data.schedule.events absent)");
  events.push(...schedule.events);

  // Pages suivantes (matchs plus lointains)
  let newer: string | undefined = schedule.pages?.newer ?? undefined;
  for (let i = 0; newer && i < (params.maxNewerPages ?? 4); i++) {
    const page = await getJson(fetchFn, "getSchedule", { ...base, pageToken: newer });
    const s = page?.data?.schedule;
    if (!Array.isArray(s?.events)) break;
    events.push(...s.events);
    newer = s.pages?.newer ?? undefined;
  }

  const seen = new Set<string>();
  const matches: Match[] = [];
  for (const ev of events) {
    const match = eventToMatch(ev, { teamName: params.teamName, aliases: params.aliases });
    if (!match || seen.has(match.id)) continue;
    seen.add(match.id);
    matches.push(match);
  }
  if (params.debug) console.log(`[DEBUG] Événements bruts : ${events.length} → matchs ${params.teamName} : ${matches.length}`);
  return { matches, leagueNames };
}
