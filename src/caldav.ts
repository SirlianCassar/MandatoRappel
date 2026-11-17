import { XMLParser } from "fast-xml-parser";

export type CaldavCalendar = {
  url: string; // collection URL (doit finir par /)
  displayName: string;
  supportsVevent: boolean;
  writable: boolean;
};

type FetchLike = typeof fetch;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

function ensureTrailingSlash(u: string): string {
  return u.endsWith("/") ? u : `${u}/`;
}

function resolveHref(base: string, href: string): string {
  return new URL(href, base).toString();
}

function getHeader(headers: Headers, name: string): string | undefined {
  // iCloud renvoie parfois ETag/etag
  const v = headers.get(name);
  if (v) return v;
  const lower = name.toLowerCase();
  for (const [k, val] of headers.entries()) {
    if (k.toLowerCase() === lower) return val;
  }
  return undefined;
}

function authHeader(username: string, password: string): string {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function propfind(fetchFn: FetchLike, url: string, xmlBody: string, depth: 0 | 1): Promise<any> {
  const res = await fetchFn(url, {
    method: "PROPFIND",
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      Depth: String(depth),
    },
    body: xmlBody,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PROPFIND ${url} -> ${res.status}\n${text}`);
  }
  return parser.parse(text);
}

function asArray<T>(x: T | T[] | undefined): T[] {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

export function createAuthedFetch(username: string, password: string): FetchLike {
  const auth = authHeader(username, password);
  return (input: any, init?: any) => {
    const headers = new Headers(init?.headers ?? {});
    headers.set("Authorization", auth);
    headers.set("User-Agent", "MandatoRappel/2.0 (CalDAV Sync)");
    return fetch(input, { ...init, headers });
  };
}

export async function discoverCalendars(fetchFn: FetchLike, baseUrl = "https://caldav.icloud.com/"): Promise<CaldavCalendar[]> {
  const base = ensureTrailingSlash(baseUrl);

  // 1) current-user-principal
  const principalPf = await propfind(
    fetchFn,
    base,
    `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-principal/>
  </D:prop>
</D:propfind>`,
    0
  );

  const principalResp = asArray(principalPf?.multistatus?.response)?.[0];
  const principalProp = asArray(principalResp?.propstat)?.[0]?.prop ?? principalResp?.propstat?.prop;
  const principalHref = principalProp?.["current-user-principal"]?.href;

  if (!principalHref) {
    throw new Error("Impossible de découvrir current-user-principal sur iCloud CalDAV.");
  }

  const principalUrl = resolveHref(base, principalHref);

  // 2) calendar-home-set
  const homePf = await propfind(
    fetchFn,
    principalUrl,
    `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-home-set/>
  </D:prop>
</D:propfind>`,
    0
  );

  const homeResp = asArray(homePf?.multistatus?.response)?.[0];
  const homeProp = asArray(homeResp?.propstat)?.[0]?.prop ?? homeResp?.propstat?.prop;
  const homeHref = homeProp?.["calendar-home-set"]?.href;

  if (!homeHref) {
    throw new Error("Impossible de découvrir calendar-home-set sur iCloud CalDAV.");
  }

  const homeUrl = ensureTrailingSlash(resolveHref(base, homeHref));

  // 3) list calendars (Depth:1) et filtre resourcetype=calendar
  const calendarsPf = await propfind(
    fetchFn,
    homeUrl,
    `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <D:current-user-privilege-set/>
    <C:supported-calendar-component-set/>
  </D:prop>
</D:propfind>`,
    1
  );

  const responses = asArray(calendarsPf?.multistatus?.response);
  const calendars: CaldavCalendar[] = [];
  for (const r of responses) {
    const href = r?.href;
    const prop = asArray(r?.propstat)?.[0]?.prop ?? r?.propstat?.prop;
    const displayName = prop?.displayname ?? "";
    const resType = prop?.resourcetype;
    const privilegeSet = prop?.["current-user-privilege-set"];
    const supported = prop?.["supported-calendar-component-set"];

    const isCalendar =
      !!resType?.calendar ||
      (typeof resType === "object" && Object.prototype.hasOwnProperty.call(resType, "calendar"));

    if (!href || !isCalendar) continue;

    // supported-calendar-component-set: contient typiquement <comp name="VEVENT"/>
    const comps = asArray(supported?.comp);
    const supportsVevent = comps.length === 0
      ? true // certains serveurs omettent ce champ -> on suppose VEVENT supporté
      : comps.some((c: any) => String(c?.["@_name"] ?? "").toUpperCase() === "VEVENT");

    // current-user-privilege-set: liste de privilèges (ex: write-content, all...)
    const privileges = asArray(privilegeSet?.privilege).flatMap((p: any) => {
      if (!p || typeof p !== "object") return [];
      return Object.keys(p).map((k) => String(k));
    });
    const writable = privileges.includes("all") || privileges.includes("write") || privileges.includes("write-content");

    calendars.push({
      url: ensureTrailingSlash(resolveHref(homeUrl, href)),
      displayName: String(displayName || "").trim() || "(sans nom)",
      supportsVevent,
      writable,
    });
  }

  if (calendars.length === 0) {
    throw new Error("Aucun calendrier CalDAV détecté (resourcetype=calendar).");
  }
  return calendars;
}

export async function putCalendarObject(params: {
  fetchFn: FetchLike;
  objectUrl: string;
  ics: string;
  etag?: string;
  createOnly: boolean;
}): Promise<{ etag?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "text/calendar; charset=utf-8",
  };
  if (params.createOnly) {
    headers["If-None-Match"] = "*";
  } else if (params.etag) {
    headers["If-Match"] = params.etag;
  }

  const res = await params.fetchFn(params.objectUrl, {
    method: "PUT",
    headers,
    body: params.ics,
  });

  // 412 en createOnly => existe déjà
  if (!res.ok && !(params.createOnly && res.status === 412)) {
    const text = await res.text().catch(() => "");
    throw new Error(`PUT ${params.objectUrl} -> ${res.status}\n${text}`);
  }

  const etag = getHeader(res.headers, "etag") ?? getHeader(res.headers, "ETag");
  return { etag: etag?.trim() };
}

export type CalendarObject = { url: string; etag?: string; data: string };

/** Liste les événements d'une période (REPORT calendar-query), avec leur contenu iCalendar. */
export async function listEvents(params: {
  fetchFn: FetchLike;
  calendarUrl: string;
  fromUtcIso: string;
  toUtcIso: string;
}): Promise<CalendarObject[]> {
  const fmt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const res = await params.fetchFn(params.calendarUrl, {
    method: "REPORT",
    headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "1" },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${fmt(params.fromUtcIso)}" end="${fmt(params.toUtcIso)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`REPORT ${params.calendarUrl} -> ${res.status}\n${text.slice(0, 500)}`);
  const xml = parser.parse(text);
  return asArray(xml?.multistatus?.response)
    .map((r: any) => {
      const prop = asArray(r?.propstat)?.[0]?.prop ?? r?.propstat?.prop;
      const data = prop?.["calendar-data"];
      const raw = typeof data === "string" ? data : typeof data?.["#text"] === "string" ? data["#text"] : "";
      return { url: resolveHref(params.calendarUrl, String(r?.href ?? "")), etag: prop?.getetag, data: raw };
    })
    .filter((o: CalendarObject) => o.data.length > 0);
}

export async function deleteCalendarObject(params: {
  fetchFn: FetchLike;
  objectUrl: string;
  etag?: string;
}): Promise<void> {
  const headers: Record<string, string> = {};
  if (params.etag) headers["If-Match"] = params.etag;
  const res = await params.fetchFn(params.objectUrl, { method: "DELETE", headers });
  // 404 = déjà supprimé
  if (res.status === 404) return;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DELETE ${params.objectUrl} -> ${res.status}\n${text}`);
  }
}


