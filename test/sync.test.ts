import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { eventToMatch, fetchRiotMatches, pickLeagues } from "../src/sources/riot.js";
import { planSync, uidFor, buildFeed } from "../src/sync.js";
import { emptyState } from "../src/state.js";
import { buildEventPayload } from "../src/format.js";
import { buildIcs, foldLine } from "../src/ics.js";
import type { Match } from "../src/model.js";

const cfg = {
  streamUrl: "https://www.twitch.tv/zerator",
  matchPageUrl: "https://valorantesports.com/fr-FR/",
  preMatchMinutes: 30,
  postMatchMinutes: 30,
  notifyResults: true,
  removeAfterMissingRuns: 3,
  teamName: "MDR",
};

function rawEvent(over: { id?: string; start?: string; state?: string; opp?: string; oppCode?: string; wins?: [number, number]; outcome?: string; count?: number } = {}) {
  return {
    startTime: over.start ?? "2026-11-13T19:00:00Z",
    state: over.state ?? "unstarted",
    type: "match",
    blockName: "Semaine 4",
    league: { name: "Challengers France", slug: "challengers_france" },
    match: {
      id: over.id ?? "113000000000001",
      strategy: { type: "bestOf", count: over.count ?? 3 },
      teams: [
        { name: over.opp ?? "Joblife", code: over.oppCode ?? "JL", record: { wins: 3, losses: 1 }, result: { outcome: null, gameWins: over.wins?.[1] ?? 0 } },
        { name: "Mandatory", code: "MDR", record: { wins: 4, losses: 0 }, result: { outcome: over.outcome ?? null, gameWins: over.wins?.[0] ?? 0 } },
      ],
    },
  };
}

const opts = { teamName: "MDR", aliases: ["Mandatory"] };
const NOW = DateTime.fromISO("2026-11-08T10:00:00Z", { zone: "utc" });

test("eventToMatch : extrait équipe, adversaire, BO et compétition", () => {
  const m = eventToMatch(rawEvent(), opts)!;
  assert.equal(m.team.code, "MDR");
  assert.equal(m.opponent.name, "Joblife");
  assert.equal(m.bestOf, 3);
  assert.equal(m.stage, "Semaine 4");
  assert.equal(m.status, "upcoming");
  assert.equal(m.score, undefined);
});

test("eventToMatch : ignore TBD et les matchs sans MDR", () => {
  assert.equal(eventToMatch(rawEvent({ opp: "TBD", oppCode: "TBD" }), opts), null);
  const other = rawEvent();
  other.match.teams[1] = { ...other.match.teams[1]!, name: "Gentle Mates", code: "M8" };
  assert.equal(eventToMatch(other, opts), null);
});

test("eventToMatch : résultat d'un match terminé", () => {
  const m = eventToMatch(rawEvent({ state: "completed", wins: [2, 1], outcome: "win" }), opts)!;
  assert.deepEqual(m.score, { team: 2, opponent: 1 });
  assert.equal(m.outcome, "win");
});

test("pickLeagues : tolère accents, casse et slugs", () => {
  const leagues = [
    { id: "1", name: "VCT EMEA", slug: "vct_emea" },
    { id: "2", name: "Challengers France", slug: "challengers_france" },
    { id: "3", name: "Challengers Spain", slug: "challengers_spain" },
  ];
  assert.deepEqual(pickLeagues(leagues, ["challengers  FRANCE"]).map((l) => l.id), ["2"]);
});

test("fetchRiotMatches : ligues + pagination avec un faux fetch", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url.pathname.split("/").pop() + (url.searchParams.get("pageToken") ? "+page" : ""));
    let body: unknown;
    if (url.pathname.endsWith("getLeagues")) body = { data: { leagues: [{ id: "42", name: "Challengers France", slug: "challengers_france" }] } };
    else if (!url.searchParams.get("pageToken")) body = { data: { schedule: { pages: { newer: "tok" }, events: [rawEvent()] } } };
    else body = { data: { schedule: { pages: { newer: null }, events: [rawEvent({ id: "2", start: "2026-11-20T19:00:00Z", opp: "Gentle Mates", oppCode: "M8" })] } } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const { matches } = await fetchRiotMatches({ teamName: "MDR", aliases: [], leagues: ["Challengers France"], leagueIds: [], fetchFn: fakeFetch });
  assert.equal(matches.length, 2);
  assert.deepEqual(calls, ["getLeagues", "getSchedule", "getSchedule+page"]);
});

test("fetchRiotMatches : erreur claire si la ligue est introuvable", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ data: { leagues: [{ id: "1", name: "VCT EMEA" }] } }))) as unknown as typeof fetch;
  await assert.rejects(fetchRiotMatches({ teamName: "MDR", aliases: [], leagues: ["Challengers France"], leagueIds: [], fetchFn: fakeFetch }), /Aucune ligue/);
});

function m(over: Partial<Match> = {}): Match {
  return { ...eventToMatch(rawEvent(), opts)!, ...over };
}

test("planSync : premier lancement → création + récapitulatif unique", () => {
  const plan = planSync({ matches: [m(), m({ id: "2", startUtcIso: "2026-11-20T19:00:00.000Z" })], state: emptyState(), freshState: true, now: NOW, cfg, canDetectRemovals: true });
  assert.equal(plan.stats.created, 2);
  assert.equal(plan.notices.length, 1);
  assert.equal(plan.notices[0]!.kind, "digest");
});

test("planSync : run suivant sans changement → aucune action, aucune notif", () => {
  const first = planSync({ matches: [m()], state: emptyState(), freshState: true, now: NOW, cfg, canDetectRemovals: true });
  // Même le lendemain : les rappels ne dépendent plus du jour d'exécution.
  const second = planSync({ matches: [m()], state: first.nextState, freshState: false, now: NOW.plus({ days: 1 }), cfg, canDetectRemovals: true });
  assert.equal(second.actions.length, 0);
  assert.equal(second.notices.length, 0);
});

test("planSync : nouveau match → notif détaillée", () => {
  const plan = planSync({ matches: [m()], state: emptyState(), freshState: false, now: NOW, cfg, canDetectRemovals: true });
  assert.equal(plan.notices[0]!.kind, "new");
  assert.match(plan.notices[0]!.title, /MDR vs Joblife/);
  assert.match(plan.notices[0]!.body, /BO3/);
});

test("planSync : match déplacé → mise à jour + notif « déplacé »", () => {
  const first = planSync({ matches: [m()], state: emptyState(), freshState: false, now: NOW, cfg, canDetectRemovals: true });
  const moved = planSync({ matches: [m({ startUtcIso: "2026-11-14T17:00:00.000Z" })], state: first.nextState, freshState: false, now: NOW, cfg, canDetectRemovals: true });
  assert.equal(moved.stats.updated, 1);
  assert.equal(moved.notices[0]!.kind, "rescheduled");
  assert.match(moved.notices[0]!.body, /→/);
});

test("planSync : résultat notifié une seule fois, titre avec score", () => {
  const first = planSync({ matches: [m()], state: emptyState(), freshState: false, now: NOW, cfg, canDetectRemovals: true });
  const done = m({ status: "completed", score: { team: 2, opponent: 0 }, outcome: "win" });
  const later = NOW.plus({ days: 6 });
  const r1 = planSync({ matches: [done], state: first.nextState, freshState: false, now: later, cfg, canDetectRemovals: true });
  assert.equal(r1.notices[0]!.kind, "result");
  assert.ok(r1.actions[0]!.type === "put" && r1.actions[0]!.payload.summary.startsWith("✅ MDR 2–0"));
  const r2 = planSync({ matches: [done], state: r1.nextState, freshState: false, now: later, cfg, canDetectRemovals: true });
  assert.equal(r2.notices.length, 0);
});

test("planSync : match disparu supprimé seulement après 3 runs", () => {
  let st = planSync({ matches: [m()], state: emptyState(), freshState: false, now: NOW, cfg, canDetectRemovals: true }).nextState;
  for (let i = 1; i <= 2; i++) {
    const p = planSync({ matches: [], state: st, freshState: false, now: NOW, cfg, canDetectRemovals: true });
    assert.equal(p.actions.length, 0);
    st = p.nextState;
  }
  const p3 = planSync({ matches: [], state: st, freshState: false, now: NOW, cfg, canDetectRemovals: true });
  assert.deepEqual(p3.actions, [{ type: "delete", uid: uidFor("113000000000001") }]);
  assert.equal(p3.notices[0]!.kind, "removed");
});

test("planSync : en mode scraping, jamais de suppression", () => {
  let st = planSync({ matches: [m()], state: emptyState(), freshState: false, now: NOW, cfg, canDetectRemovals: true }).nextState;
  for (let i = 0; i < 5; i++) st = planSync({ matches: [], state: st, freshState: false, now: NOW, cfg, canDetectRemovals: false }).nextState;
  assert.ok(Object.keys(st.events).length === 1);
});

test("planSync : bascule de source sans doublon (même heure + même adversaire)", () => {
  const first = planSync({ matches: [m()], state: emptyState(), freshState: false, now: NOW, cfg, canDetectRemovals: true });
  const scraped = m({ id: "s-abc", source: "scrape", opponent: { name: "JL", code: "JL" } });
  const p = planSync({ matches: [scraped], state: first.nextState, freshState: false, now: NOW, cfg, canDetectRemovals: false });
  assert.equal(p.stats.created, 0);
});

test("planSync : on ne crée pas d'événement pour un match passé", () => {
  const p = planSync({ matches: [m({ startUtcIso: "2026-11-01T19:00:00.000Z", status: "completed" })], state: emptyState(), freshState: false, now: NOW, cfg, canDetectRemovals: true });
  assert.equal(p.actions.length, 0);
});

test("format : événement lisible et horaires", () => {
  const p = buildEventPayload(m(), cfg);
  assert.equal(p.summary, "MDR vs Joblife");
  assert.equal(p.location, "Challengers France · Semaine 4 · BO3");
  assert.equal(p.startUtcIso, "2026-11-13T18:30:00.000Z"); // 30 min avant
  assert.equal(p.endUtcIso, "2026-11-13T22:00:00.000Z"); // BO3 ≈ 2h30 + 30 min
  assert.match(p.description, /Début officiel : ven\. 13 nov\.? · 20:00/);
  assert.match(p.description, /Joblife \(JL\) — 3V – 1D/);
});

test("ics : lignes pliées à 75 octets sans casser l'UTF-8", () => {
  const folded = foldLine("DESCRIPTION:" + "é".repeat(100));
  for (const line of folded.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75);
  assert.equal(folded.split("\r\n").map((l, i) => (i ? l.slice(1) : l)).join(""), "DESCRIPTION:" + "é".repeat(100));
  const ics = buildIcs({ uid: "mdr2-1", dtstampUtcIso: NOW.toISO()!, payload: buildEventPayload(m(), cfg) });
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 2);
  assert.match(ics, /TRIGGER;VALUE=DATE-TIME:20261112T190000Z/); // 1 jour avant
});

test("feed : prochain match en tête", () => {
  const feed = buildFeed([m({ id: "2", startUtcIso: "2026-11-20T19:00:00.000Z" }), m()], NOW);
  assert.equal(feed.next?.id, "113000000000001");
  assert.equal(feed.upcoming.length, 2);
});
