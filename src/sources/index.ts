import type { Config } from "../config.js";
import type { Match } from "../model.js";
import { fetchRiotMatches } from "./riot.js";

export class NeedsFallback extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export type SourceResult = {
  matches: Match[];
  source: "riot" | "scrape";
  /** Raison du passage au secours, si applicable. */
  fallbackReason?: string;
};

async function scrape(cfg: Config): Promise<Match[]> {
  const { scrapeMatches } = await import("./scrape.js");
  return scrapeMatches({ teamName: cfg.teamName });
}

export async function getMatches(cfg: Config): Promise<SourceResult> {
  if (cfg.source === "scrape") {
    return { matches: await scrape(cfg), source: "scrape", fallbackReason: cfg.fallbackReason };
  }

  try {
    const { matches } = await fetchRiotMatches({
      teamName: cfg.teamName,
      aliases: cfg.teamAliases,
      leagues: cfg.leagues,
      leagueIds: cfg.leagueIds,
      debug: cfg.debug,
    });
    return { matches, source: "riot" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[WARN] API officielle indisponible : ${reason}`);
    if (cfg.source === "riot" || cfg.fallback === "off") throw e;
    // Dans GitHub Actions, on laisse le workflow installer le navigateur puis relancer en mode scraping.
    if (cfg.fallback === "defer") throw new NeedsFallback(reason);
    return { matches: await scrape(cfg), source: "scrape", fallbackReason: reason };
  }
}
