/**
 * État minimal, sans aucune donnée iCloud (pas d'URL ni d'identifiant de compte).
 * Stocké sur la branche `state` du dépôt par le workflow. Le contenu est déterministe :
 * un run sans changement ne produit aucun commit.
 */
import fs from "node:fs/promises";
import path from "node:path";

export type TrackedEvent = {
  matchId: string;
  hash: string; // empreinte du contenu poussé sur iCloud
  startUtcIso: string; // heure officielle
  summary: string;
  opponent: string;
  status: "upcoming" | "live" | "completed";
  resultNotified?: boolean;
  missingRuns?: number; // nombre de runs consécutifs où le match n'apparaît plus
};

export type State = {
  version: 2;
  events: Record<string, TrackedEvent>; // clé = UID de l'événement
  health: {
    consecutiveFailures: number;
    lastFailureNotifiedDay?: string; // YYYY-MM-DD, pour limiter les alertes
    lastFallbackNotifiedDay?: string;
  };
  migratedV1?: boolean;
};

export const STATE_PATH = path.resolve(process.env.STATE_PATH ?? "data/state.json");
export const FEED_PATH = path.resolve(process.env.FEED_PATH ?? "data/matches.json");

export function emptyState(): State {
  return { version: 2, events: {}, health: { consecutiveFailures: 0 } };
}

export async function readState(p = STATE_PATH): Promise<{ state: State; fresh: boolean }> {
  try {
    const json = JSON.parse(await fs.readFile(p, "utf8"));
    if (json?.version !== 2 || typeof json.events !== "object") throw new Error("version d'état inconnue");
    return { state: { ...emptyState(), ...json, health: { ...emptyState().health, ...json.health } }, fresh: false };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[WARN] État illisible, on repart de zéro : ${String(e)}`);
    return { state: emptyState(), fresh: true };
  }
}

/** Sérialisation stable (clés triées) pour éviter les commits inutiles. */
export function stableStringify(value: unknown): string {
  const sort = (v: any): any =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sort(v[k])]))
        : v;
  return JSON.stringify(sort(value), null, 2) + "\n";
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, stableStringify(value), "utf8");
}
