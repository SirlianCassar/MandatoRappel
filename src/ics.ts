import type { MatchPayload } from "./types.js";

function icsEscapeText(value: string): string {
  // RFC5545: escape backslash, semicolon, comma, newline
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function foldLine(line: string): string {
  // Pliage simple: 75 octets max recommandé; on coupe à ~70 chars pour rester safe en UTF-8.
  const limit = 70;
  if (line.length <= limit) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i + limit);
    parts.push(i === 0 ? chunk : ` ${chunk}`);
    i += limit;
  }
  return parts.join("\r\n");
}

function fmtUtc(dtIso: string): string {
  // attend un ISO UTC; on produit YYYYMMDDTHHMMSSZ
  const d = new Date(dtIso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function addAlarm(lines: string[], triggerLine: string): void {
  lines.push("BEGIN:VALARM");
  lines.push(triggerLine);
  lines.push("ACTION:DISPLAY");
  lines.push("DESCRIPTION:Reminder");
  lines.push("END:VALARM");
}

export function buildIcs(params: {
  uid: string;
  dtstampUtcIso: string;
  payload: MatchPayload;
  keepMinus1DayAlarm: boolean;
}): string {
  const { uid, dtstampUtcIso, payload, keepMinus1DayAlarm } = params;

  // Notes: strictement 2 lignes, rien d'autre.
  // On impose \n et on s'assure qu'il n'y a pas de 3e ligne.
  const descLines = payload.description.split(/\r?\n/).filter((l) => l.length > 0);
  if (descLines.length !== 2) {
    throw new Error("Description invalide: doit contenir exactement 2 lignes non vides.");
  }

  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//MandatoRappel//MDR Sync//FR");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push("BEGIN:VEVENT");
  lines.push(`UID:${icsEscapeText(uid)}`);
  lines.push(`DTSTAMP:${fmtUtc(dtstampUtcIso)}`);
  lines.push(`DTSTART:${fmtUtc(payload.startUtcIso)}`);
  lines.push(`DTEND:${fmtUtc(payload.endUtcIso)}`);
  lines.push(`SUMMARY:${icsEscapeText(payload.summary)}`);
  lines.push(`LOCATION:${icsEscapeText(payload.location)}`);
  lines.push(`DESCRIPTION:${icsEscapeText(descLines.join("\n"))}`);
  lines.push("TRANSP:OPAQUE");

  // Alarmes (VALARM)
  // Règles:
  // - toujours 1h avant le début officiel
  // - +1j avant le début officiel si demandé
  //
  // IMPORTANT: l'événement est décalé (DTSTART = officiel - 30min),
  // donc on utilise des TRIGGER absolus (VALUE=DATE-TIME) basés sur l'heure officielle.
  const refStartIso = payload.officialStartUtcIso ?? payload.startUtcIso;
  const ref = new Date(refStartIso);
  const minus1Hour = new Date(ref.getTime() - 60 * 60 * 1000).toISOString();
  addAlarm(lines, `TRIGGER;VALUE=DATE-TIME:${fmtUtc(minus1Hour)}`);
  if (keepMinus1DayAlarm) {
    const minus1Day = new Date(ref.getTime() - 24 * 60 * 60 * 1000).toISOString();
    addAlarm(lines, `TRIGGER;VALUE=DATE-TIME:${fmtUtc(minus1Day)}`);
  }

  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}


