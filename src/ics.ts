import type { EventPayload } from "./format.js";

function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Pliage RFC 5545 : 75 octets max par ligne, sans couper un caractère UTF-8. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? 75 : 74; // les lignes de continuation commencent par un espace
    if (bytes + b > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join("\r\n");
}

export function fmtUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildIcs(params: { uid: string; dtstampUtcIso: string; payload: EventPayload }): string {
  const { uid, dtstampUtcIso, payload: p } = params;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MandatoRappel//MDR Sync v2//FR",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${esc(uid)}`,
    `DTSTAMP:${fmtUtc(dtstampUtcIso)}`,
    `DTSTART:${fmtUtc(p.startUtcIso)}`,
    `DTEND:${fmtUtc(p.endUtcIso)}`,
    `SUMMARY:${esc(p.summary)}`,
    `LOCATION:${esc(p.location)}`,
    `DESCRIPTION:${esc(p.description)}`,
    `URL:${p.url}`,
    "TRANSP:OPAQUE",
  ];
  // Rappels absolus, calés sur l'heure officielle (l'événement commence plus tôt).
  for (const a of p.alarmsUtcIso) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(p.summary)}`, `TRIGGER;VALUE=DATE-TIME:${fmtUtc(a)}`, "END:VALARM");
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
