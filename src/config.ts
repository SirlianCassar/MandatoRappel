/** Lecture et validation de la configuration (variables d'environnement). */

export type SourceMode = "auto" | "riot" | "scrape";
export type FallbackMode = "inline" | "defer" | "off";

export type Config = {
  icloudUsername: string;
  icloudAppPassword: string;
  calendarName?: string;
  teamName: string;
  teamAliases: string[];
  leagues: string[];
  leagueIds: string[];
  source: SourceMode;
  fallback: FallbackMode;
  fallbackReason?: string;
  dryRun: boolean;
  debug: boolean;
  streamUrl: string;
  matchPageUrl: string;
  preMatchMinutes: number;
  postMatchMinutes: number;
  notifyResults: boolean;
  notifyBackends: string[];
  removeAfterMissingRuns: number;
  runUrl?: string;
};

function truthy(v: string | undefined, dflt = false): boolean {
  if (v === undefined || v.trim() === "") return dflt;
  return ["1", "true", "yes", "y", "on", "oui"].includes(v.trim().toLowerCase());
}

function list(v: string | undefined, dflt: string[] = []): string[] {
  if (!v || v.trim() === "") return dflt;
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function int(v: string | undefined, dflt: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env, opts: { requireIcloud?: boolean } = {}): Config {
  const requireIcloud = opts.requireIcloud ?? true;
  const missing: string[] = [];
  if (requireIcloud && !env.ICLOUD_USERNAME) missing.push("ICLOUD_USERNAME");
  if (requireIcloud && !env.ICLOUD_APP_PASSWORD) missing.push("ICLOUD_APP_PASSWORD");
  if (missing.length) throw new Error(`Variables d'environnement manquantes : ${missing.join(", ")}`);

  const source = (env.SOURCE ?? "auto").trim().toLowerCase();
  const fallback = (env.FALLBACK_MODE ?? "inline").trim().toLowerCase();

  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;

  return {
    icloudUsername: env.ICLOUD_USERNAME ?? "",
    icloudAppPassword: env.ICLOUD_APP_PASSWORD ?? "",
    calendarName: env.ICLOUD_CALENDAR_NAME?.trim() || undefined,
    teamName: (env.TEAM_NAME ?? "MDR").trim() || "MDR",
    teamAliases: list(env.TEAM_ALIASES, ["Mandatory"]),
    leagues: list(env.LEAGUES, ["Challengers France"]),
    leagueIds: list(env.LEAGUE_IDS),
    source: (["auto", "riot", "scrape"].includes(source) ? source : "auto") as SourceMode,
    fallback: (["inline", "defer", "off"].includes(fallback) ? fallback : "inline") as FallbackMode,
    fallbackReason: env.FALLBACK_REASON?.trim() || undefined,
    dryRun: truthy(env.DRY_RUN),
    debug: truthy(env.DEBUG),
    streamUrl: env.STREAM_URL?.trim() || "https://www.twitch.tv/zerator",
    matchPageUrl: env.MATCH_PAGE_URL?.trim() || "https://valorantesports.com/fr-FR/",
    preMatchMinutes: int(env.PRE_MATCH_MINUTES, 30),
    postMatchMinutes: int(env.POST_MATCH_MINUTES, 30),
    notifyResults: truthy(env.NOTIFY_RESULTS, true),
    // NOTIFY_BACKENDS (plusieurs, séparés par des virgules) ; NOTIFY_BACKEND gardé pour compatibilité v1.
    notifyBackends: list(env.NOTIFY_BACKENDS ?? env.NOTIFY_BACKEND).map((b) => b.toLowerCase()).filter((b) => b !== "none"),
    removeAfterMissingRuns: int(env.REMOVE_AFTER_MISSING_RUNS, 3),
    runUrl,
  };
}
