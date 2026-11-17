/** Modèle de match commun à toutes les sources (API officielle ou scraping de secours). */

export type MatchStatus = "upcoming" | "live" | "completed";

export type TeamInfo = {
  name: string; // ex: "Joblife"
  code: string; // ex: "JL" (peut être égal au nom si inconnu)
  record?: { wins: number; losses: number };
};

export type Match = {
  /** Identifiant stable du match (id officiel Riot si dispo). */
  id: string;
  source: "riot" | "scrape";
  startUtcIso: string;
  status: MatchStatus;
  bestOf?: number;
  league: string; // ex: "Challengers France"
  stage?: string; // ex: "Semaine 2", "Playoffs"
  team: TeamInfo; // l'équipe suivie (MDR)
  opponent: TeamInfo;
  /** Score en manches (maps) gagnées, si le match a commencé. */
  score?: { team: number; opponent: number };
  outcome?: "win" | "loss";
};

export function isUnknownTeam(t: { name?: string; code?: string } | undefined): boolean {
  if (!t) return true;
  const values = [t.name, t.code].map((v) => (v ?? "").trim().toLowerCase());
  return values.every((v) => v.length === 0 || v === "tbd" || v === "tba" || v === "?");
}

/** Normalise un texte pour les comparaisons (accents, casse, séparateurs). */
export function norm(s: string | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
