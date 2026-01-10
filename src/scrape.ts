import { chromium, type Browser, type Page } from "playwright";
import type { ScrapedMatch } from "./types.js";

const BASE_URL = "https://valorantesports.com/fr-FR/";

function isUnknownOpponent(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.length === 0 || n === "tbd";
}

function parseBoToBoX(boText: string | undefined): string | undefined {
  if (!boText) return undefined;
  const m = boText.match(/(\d+)/);
  if (!m) return undefined;
  return `BO${m[1]}`;
}

async function acceptCookiesIfPresent(page: Page): Promise<void> {
  // Best effort: le site peut afficher un bandeau cookies.
  // (Osano + autres CMP). On tente plusieurs libellés.
  const candidates = [
    page.getByRole("button", { name: /tout accepter/i }),
    page.getByRole("button", { name: /^accepter$/i }),
    page.getByRole("button", { name: /accepter/i }),
    page.getByRole("button", { name: /accept all/i }),
    page.getByRole("button", { name: /^accept$/i }),
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

async function ensurePlanningView(page: Page): Promise<void> {
  // La page est un planning, mais certains blocs sont en “spoilers”.
  // En pratique, un clic sur un match révèle la vue avec les <time datetime="...Z">.
  const hasEnoughTimes = async () => {
    try {
      const count = await page.locator("time[datetime]").count();
      return count >= 3;
    } catch {
      return false;
    }
  };

  if (await hasEnoughTimes()) return;

  // Fallback: cliquer sur un bouton spoiler.
  const spoiler = page.locator("button", { hasText: /SÉRIE DE|SERIE DE|JOUER\\s+\\d|CLIQUEZ POUR AFFICHER/i }).first();
  await spoiler.click({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll("time[datetime]").length >= 3, undefined, { timeout: 10_000 });
}

type DomMatch = {
  startUtcIso: string;
  leftTeam: string;
  rightTeam: string;
  tournament: string;
  boText?: string;
};

async function extractDomMatches(page: Page): Promise<DomMatch[]> {
  return page.evaluate(() => {
    const cards: DomMatch[] = [];
    const times = Array.from(document.querySelectorAll("time[datetime]"));
    for (const t of times) {
      const datetime = t.getAttribute("datetime");
      if (!datetime) continue;

      // On remonte jusqu'à la carte qui contient aussi le footer (tournoi + BO).
      let cur: HTMLElement | null = t.parentElement;
      let card: HTMLElement | null = null;
      for (let i = 0; i < 10 && cur; i++) {
        const txt = cur.textContent || "";
        if (txt.includes("•") && /SÉRIE DE|SERIE DE|JOUER\s+\d/i.test(txt)) {
          card = cur;
          break;
        }
        cur = cur.parentElement;
      }
      if (!card) continue;

      const pTeams = Array.from(card.querySelectorAll("p")).filter((p) => /tt_uppercase/i.test(p.className));
      if (pTeams.length < 2) continue;
      const leftTeam = (pTeams[0].textContent || "").replace(/\s+/g, " ").trim();
      const rightTeam = (pTeams[pTeams.length - 1].textContent || "").replace(/\s+/g, " ").trim();

      // Tournoi/stage au centre du footer (contient souvent "•")
      const footerTextCandidates = Array.from(card.querySelectorAll("footer p"))
        .map((p) => (p.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);

      const tournament = footerTextCandidates.find((x) => x.includes("•")) ?? footerTextCandidates[0] ?? "";
      if (!tournament) continue;

      const boText =
        card.querySelector("footer p[aria-label*='SÉRIE']")?.getAttribute("aria-label") ||
        footerTextCandidates.find((x) => /SÉRIE DE|SERIE DE|JOUER\s+\d/i.test(x));

      cards.push({
        startUtcIso: new Date(datetime).toISOString(),
        leftTeam,
        rightTeam,
        tournament,
        boText: boText || undefined,
      });
    }

    // Dédup (datetime + teams + tournoi)
    const seen = new Set<string>();
    return cards.filter((m) => {
      const k = `${m.startUtcIso}|${m.leftTeam}|${m.rightTeam}|${m.tournament}|${m.boText ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}

export async function scrapeMdrMatches(params: { teamName: string }): Promise<ScrapedMatch[]> {
  let browser: Browser | undefined;
  try {
    const debugEnabled = process.env.DEBUG_SCRAPE === "1" || process.env.DEBUG_SCRAPE === "true";
    const teamLower = params.teamName.trim().toLowerCase();

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "fr-FR",
      timezoneId: "Europe/Paris",
    });
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await acceptCookiesIfPresent(page);
    await ensurePlanningView(page);

    const results: ScrapedMatch[] = [];
    const maxDays = 30;

    for (let day = 0; day < maxDays; day++) {
      const domMatches = await extractDomMatches(page);
      if (debugEnabled) console.log(`[DEBUG] Jour+${day}: cards=${domMatches.length}`);

      for (const m of domMatches) {
        const leftLower = m.leftTeam.toLowerCase();
        const rightLower = m.rightTeam.toLowerCase();
        if (leftLower !== teamLower && rightLower !== teamLower) continue;

        const opponent = leftLower === teamLower ? m.rightTeam : m.leftTeam;
        if (isUnknownOpponent(opponent)) continue;

        results.push({
          teamName: params.teamName.trim(),
          opponentName: opponent,
          tournamentName: m.tournament,
          bestOf: parseBoToBoX(m.boText),
          startUtcIso: m.startUtcIso,
          sourceUrl: BASE_URL,
        });
      }

      // Next day
      const next = page.getByRole("button", { name: /SUIVANT DATE/i });
      if (!(await next.isVisible().catch(() => false))) break;
      if (!(await next.isEnabled().catch(() => false))) break;

      const prevFirst = domMatches[0]?.startUtcIso ?? null;
      await next.click({ timeout: 10_000 });
      // Attendre un changement (sinon boucle sur même journée)
      try {
        await page.waitForFunction(
          (prev) => {
            const t = document.querySelector("time[datetime]") as HTMLTimeElement | null;
            const dt = t?.getAttribute("datetime");
            if (!dt) return prev === null; // pas de données
            const iso = new Date(dt).toISOString();
            return iso !== prev;
          },
          prevFirst,
          { timeout: 10_000 }
        );
      } catch {
        // si pas de changement observable, on sort pour éviter une boucle infinie
        break;
      }
    }

    // Dédup final
    const seen = new Set<string>();
    const deduped = results.filter((m) => {
      const k = `${m.startUtcIso}|${m.teamName}|${m.opponentName}|${m.tournamentName}|${m.bestOf ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (debugEnabled) {
      console.log(`[DEBUG] Total MDR matches after filtering: ${deduped.length}`);
      for (const m of deduped.slice(0, 5)) {
        console.log(`[DEBUG] ${m.startUtcIso} | ${m.teamName} vs ${m.opponentName} | ${m.bestOf ?? "BO?"} | ${m.tournamentName}`);
      }
    }

    return deduped;
  } finally {
    await browser?.close().catch(() => {});
  }
}


