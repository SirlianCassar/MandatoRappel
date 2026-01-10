import { DateTime } from "luxon";
import type { ScrapedMatch } from "./types.js";

const LIQUIPEDIA_DEFAULT_URL = "https://liquipedia.net/valorant/Mandatory";

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function scrapeLiquipediaUpcomingMatches(params: {
  teamCode: string; // ex: "MDR"
  url?: string;
}): Promise<ScrapedMatch[]> {
  const teamCode = params.teamCode.trim();
  const html = await fetch(params.url ?? LIQUIPEDIA_DEFAULT_URL, {
    headers: {
      "User-Agent": "MandatoRappel/1.0 (Liquipedia parser)",
      "Accept-Language": "en-US,en;q=0.9",
    },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`Liquipedia HTTP ${r.status}`);
    return await r.text();
  });

  const out: ScrapedMatch[] = [];
  const seen = new Set<string>();

  // Liquipedia encode les matchs dans des <div class="carousel-item">, chacun contenant:
  // - <span class="timer-object" data-timestamp="...">Jan 11 - 18:00 CET</span>
  // - tournament: match-info-tournament-name <span>...</span>
  // - stage: match-info-stage
  // - teams: <span class="name">MDR</span> + adversaire
  const re = /data-timestamp="(\d{9,})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tsSeconds = Number(m[1]);
    if (!Number.isFinite(tsSeconds)) continue;

    const chunk = html.slice(m.index, m.index + 6000);

    const tour = chunk.match(/match-info-tournament-name[\s\S]*?<span>([^<]+)<\/span>/i)?.[1];
    const stage = chunk.match(/match-info-stage">([^<]+)<\/span>/i)?.[1];

    // Teams: prendre les 2 premiers codes dans les spans name du bloc
    const teamMatches = Array.from(chunk.matchAll(/<span class="name"[^>]*>[\s\S]*?>([^<]+)<\/a>\s*<\/span>/gi))
      .map((x) => normalizeSpaces(decodeHtml(x[1] ?? "")))
      .filter(Boolean);

    if (teamMatches.length < 2) continue;
    const a = teamMatches[0];
    const b = teamMatches[1];

    const hasTeam = a === teamCode || b === teamCode;
    if (!hasTeam) continue;

    const opponent = a === teamCode ? b : a;
    if (!opponent || opponent === "TBD") continue;

    // Timestamp est en secondes UTC (Liquipedia affiche aussi CET, mais on se base sur timestamp).
    const startUtcIso = DateTime.fromSeconds(tsSeconds, { zone: "utc" }).toISO();
    if (!startUtcIso) continue;

    const tournamentName = normalizeSpaces(
      decodeHtml([tour, stage].filter(Boolean).join(" — "))
    );
    if (!tournamentName) continue;

    const key = `${startUtcIso}|${teamCode}|${opponent}|${tournamentName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      teamName: teamCode,
      opponentName: opponent,
      tournamentName,
      // BO inconnu sur Liquipedia (on laisse undefined, conforme aux règles)
      bestOf: undefined,
      startUtcIso,
      sourceUrl: `${params.url ?? LIQUIPEDIA_DEFAULT_URL}#Upcoming_Matches`,
    });

    // Sécurité: limiter à un nombre raisonnable
    if (out.length >= 30) break;
  }

  return out;
}

