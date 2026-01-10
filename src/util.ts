import crypto from "node:crypto";

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function stableMatchId(parts: {
  startUtcIso: string;
  teamName: string;
  opponentName: string;
  tournamentName: string;
}): string {
  const base = [
    parts.startUtcIso,
    parts.teamName.trim(),
    parts.opponentName.trim(),
    parts.tournamentName.trim(),
  ].join("|");
  // identifiant lisible + hash pour éviter les soucis de caractères/longueur
  const short = sha256Hex(base).slice(0, 16);
  return `mdr-${short}`;
}

export function stableEventKeyFromSource(sourceUrl: string, fallbackMatchId: string): string {
  const u = (sourceUrl ?? "").trim();
  if (u.length > 0 && /^https?:\/\//i.test(u)) {
    const short = sha256Hex(u).slice(0, 16);
    return `evt-${short}`;
  }
  return `evt-${fallbackMatchId}`;
}

export function nowUtcIso(): string {
  return new Date().toISOString();
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}


