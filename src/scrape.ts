import { chromium, type Browser, type Page } from "playwright";
import { DateTime } from "luxon";
import type { ScrapedMatch } from "./types.js";

const BASE_URL = "https://valorantesports.com/fr-FR/";
const MATCHES_URL = "https://valorantesports.com/fr-FR/matches";

function isUnknownOpponent(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.length === 0 || n === "tbd" || n === "to be determined";
}

function parseStartToUtcIso(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  // 1) ISO avec timezone
  const iso = DateTime.fromISO(value, { setZone: true });
  if (iso.isValid) return iso.toUTC().toISO() ?? undefined;

  // 2) timestamp ms ou s en string
  if (/^\d{10,13}$/.test(value.trim())) {
    const num = Number(value.trim());
    const ms = value.trim().length === 10 ? num * 1000 : num;
    return DateTime.fromMillis(ms).toUTC().toISO() ?? undefined;
  }

  return undefined;
}

function pickString(obj: any, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function* walkJson(node: any): Generator<any> {
  if (node && typeof node === "object") {
    yield node;
    if (Array.isArray(node)) {
      for (const v of node) yield* walkJson(v);
    } else {
      for (const v of Object.values(node)) yield* walkJson(v);
    }
  }
}

function tryExtractMatchesFromJson(json: any, teamName: string): ScrapedMatch[] {
  const out: ScrapedMatch[] = [];
  const teamLower = teamName.toLowerCase();

  for (const node of walkJson(json)) {
    // Heuristique: objet qui ressemble à un match avec 2 équipes + horaire + tournoi
    const teams = node?.teams ?? node?.competitors ?? node?.participants;
    const team1 = pickString(node, ["team1", "homeTeam", "teamA", "leftTeam", "teamName1"]);
    const team2 = pickString(node, ["team2", "awayTeam", "teamB", "rightTeam", "teamName2"]);

    let names: string[] | undefined;
    if (Array.isArray(teams) && teams.length === 2) {
      const n0 = pickString(teams[0], ["name", "teamName", "displayName"]);
      const n1 = pickString(teams[1], ["name", "teamName", "displayName"]);
      if (n0 && n1) names = [n0, n1];
    } else if (team1 && team2) {
      names = [team1, team2];
    }

    if (!names) continue;
    const [a, b] = names;
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    if (aLower !== teamLower && bLower !== teamLower) continue;

    const opponent = aLower === teamLower ? b : a;
    if (isUnknownOpponent(opponent)) continue;

    const start =
      parseStartToUtcIso(pickString(node, ["startTime", "scheduledTime", "time", "dateTime", "beginAt"])) ??
      parseStartToUtcIso(node?.startTime) ??
      parseStartToUtcIso(node?.scheduledTime);
    if (!start) continue;

    // Tournoi
    const tournament =
      pickString(node?.tournament, ["name", "displayName"]) ??
      pickString(node, ["tournamentName", "leagueName", "eventName", "competitionName"]);
    if (!tournament) continue; // match incomplet (règles métier)

    // BO (optionnel)
    const boRaw =
      pickString(node, ["bestOf", "bo", "matchFormat", "format"]) ??
      pickString(node?.format, ["name", "shortName"]);
    const bestOf = typeof boRaw === "string" && /bo\d/i.test(boRaw) ? boRaw.toUpperCase() : undefined;

    const sourceUrl = typeof node?.url === "string" ? node.url : BASE_URL;

    out.push({
      teamName,
      opponentName: opponent,
      tournamentName: tournament,
      bestOf,
      startUtcIso: start,
      sourceUrl,
    });
  }

  // Déduplication brute (mêmes champs)
  const seen = new Set<string>();
  return out.filter((m) => {
    const k = `${m.startUtcIso}|${m.teamName}|${m.opponentName}|${m.tournamentName}|${m.bestOf ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function acceptCookiesIfPresent(page: Page): Promise<void> {
  // Best effort: le site peut afficher un bandeau cookies.
  const candidates = [
    page.getByRole("button", { name: /accepter/i }),
    page.getByRole("button", { name: /tout accepter/i }),
    page.getByRole("button", { name: /accept/i }),
  ];
  for (const loc of candidates) {
    try {
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.click({ timeout: 1500 });
        return;
      }
    } catch {
      // ignore
    }
  }
}

export async function scrapeMdrMatches(params: { teamName: string }): Promise<ScrapedMatch[]> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "fr-FR",
      timezoneId: "Europe/Paris",
    });
    const page = await context.newPage();

    const collectedJson: any[] = [];
    page.on("response", async (res) => {
      try {
        const ct = res.headers()["content-type"] ?? "";
        const url = res.url();
        if (!ct.includes("application/json")) return;
        // Heuristique : endpoints souvent liés aux matchs/schedule
        if (!/match|schedule|event|esports|calendar/i.test(url)) return;
        const j = await res.json();
        collectedJson.push(j);
      } catch {
        // ignore
      }
    });

    await page.goto(MATCHES_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await acceptCookiesIfPresent(page);
    await page.waitForTimeout(6_000);

    // 1) Extraction via JSON collecté (priorité)
    for (const j of collectedJson) {
      const matches = tryExtractMatchesFromJson(j, params.teamName);
      if (matches.length > 0) return matches;
    }

    // 2) Fallback: __NEXT_DATA__ si présent (Next.js)
    const nextData = await page.evaluate(() => {
      const el = document.querySelector("#__NEXT_DATA__");
      if (!el?.textContent) return null;
      try {
        return JSON.parse(el.textContent);
      } catch {
        return null;
      }
    });
    if (nextData) {
      const matches = tryExtractMatchesFromJson(nextData, params.teamName);
      if (matches.length > 0) return matches;
    }

    // 3) Fallback DOM très basique (moins fiable, mais mieux que rien)
    // On récupère le texte de la page et on tente de repérer un pattern "TEAM vs TEAM" proche d'une date.
    const pageText = (await page.textContent("body")) ?? "";
    if (!pageText.toLowerCase().includes(params.teamName.toLowerCase())) return [];

    // Impossible de garantir une extraction correcte sans structure; on préfère retourner vide
    // plutôt que de créer des événements erronés.
    return [];
  } finally {
    await browser?.close().catch(() => {});
  }
}


