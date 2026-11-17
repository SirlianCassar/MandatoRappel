/**
 * Notifications push. Plusieurs services peuvent être actifs en même temps :
 * NOTIFY_BACKENDS="ntfy,pushcut" par exemple.
 */
import type { Backend, Notice } from "./types.js";

export type { Notice } from "./types.js";

async function post(url: string, init: { headers?: Record<string, string>; json?: unknown; form?: Record<string, string> }): Promise<void> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

function need(env: NodeJS.ProcessEnv, ...keys: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k]?.trim();
    if (!v) {
      console.warn(`[WARN] Notification : variable ${k} manquante, service ignoré.`);
      return null;
    }
    out[k] = v;
  }
  return out;
}

const NTFY_PRIORITY = { low: 2, default: 3, high: 4 } as const;
const NTFY_TAGS: Record<Notice["kind"], string[]> = {
  new: ["calendar"],
  rescheduled: ["clock3"],
  updated: ["pencil2"],
  result: ["trophy"],
  removed: ["wastebasket"],
  digest: ["calendar"],
  error: ["warning"],
  fallback: ["construction"],
  test: ["white_check_mark"],
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function createBackends(names: string[], env: NodeJS.ProcessEnv = process.env): Backend[] {
  const backends: Backend[] = [];
  for (const name of names) {
    switch (name) {
      case "ntfy": {
        const c = need(env, "NOTIFY_NTFY_TOPIC");
        if (!c) break;
        const server = (env.NOTIFY_NTFY_SERVER?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
        const token = env.NOTIFY_NTFY_TOKEN?.trim();
        backends.push({
          name,
          send: (n) =>
            post(server, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              json: {
                topic: c.NOTIFY_NTFY_TOPIC,
                title: n.title,
                message: n.body,
                priority: NTFY_PRIORITY[n.priority],
                tags: NTFY_TAGS[n.kind],
                click: n.url,
                actions: n.url ? [{ action: "view", label: n.url.includes("twitch") ? "Ouvrir Twitch" : "Ouvrir", url: n.url }] : undefined,
              },
            }),
        });
        break;
      }
      case "pushover": {
        const c = need(env, "NOTIFY_PUSHOVER_API_TOKEN", "NOTIFY_PUSHOVER_USER_KEY");
        if (!c) break;
        backends.push({
          name,
          send: (n) =>
            post("https://api.pushover.net/1/messages.json", {
              form: {
                token: c.NOTIFY_PUSHOVER_API_TOKEN!,
                user: c.NOTIFY_PUSHOVER_USER_KEY!,
                title: n.title,
                message: n.body,
                priority: n.priority === "high" ? "1" : n.priority === "low" ? "-1" : "0",
                ...(n.url ? { url: n.url, url_title: n.url.includes("twitch") ? "Ouvrir Twitch" : "Ouvrir" } : {}),
              },
            }),
        });
        break;
      }
      case "pushcut": {
        const c = need(env, "NOTIFY_PUSHCUT_API_KEY", "NOTIFY_PUSHCUT_NOTIFICATION_KEY");
        if (!c) break;
        backends.push({
          name,
          send: (n) =>
            post(`https://api.pushcut.io/v1/notifications/${encodeURIComponent(c.NOTIFY_PUSHCUT_NOTIFICATION_KEY!)}`, {
              headers: { "API-Key": c.NOTIFY_PUSHCUT_API_KEY! },
              json: {
                title: n.title,
                text: n.body,
                ...(n.url ? { defaultAction: { url: n.url } } : {}),
                // Transmis tel quel au Raccourci lancé par la notification (entrée du raccourci).
                input: JSON.stringify({ kind: n.kind, title: n.title, body: n.body, url: n.url, match: n.match ?? null }),
              },
            }),
        });
        break;
      }
      case "telegram": {
        const c = need(env, "NOTIFY_TELEGRAM_BOT_TOKEN", "NOTIFY_TELEGRAM_CHAT_ID");
        if (!c) break;
        backends.push({
          name,
          send: (n) =>
            post(`https://api.telegram.org/bot${c.NOTIFY_TELEGRAM_BOT_TOKEN}/sendMessage`, {
              json: {
                chat_id: c.NOTIFY_TELEGRAM_CHAT_ID,
                parse_mode: "HTML",
                disable_web_page_preview: true,
                text: `<b>${escapeHtml(n.title)}</b>\n${escapeHtml(n.body)}`,
                ...(n.url ? { reply_markup: { inline_keyboard: [[{ text: n.url.includes("twitch") ? "📺 Twitch" : "🔗 Ouvrir", url: n.url }]] } } : {}),
              },
            }),
        });
        break;
      }
      case "discord": {
        const c = need(env, "NOTIFY_DISCORD_WEBHOOK_URL");
        if (!c) break;
        const colors: Partial<Record<Notice["kind"], number>> = { error: 0xe74c3c, result: 0xf1c40f, rescheduled: 0xe67e22, new: 0x3498db };
        backends.push({
          name,
          send: (n) =>
            post(c.NOTIFY_DISCORD_WEBHOOK_URL!, {
              json: { username: "MDR Calendar", embeds: [{ title: n.title, description: n.body, url: n.url, color: colors[n.kind] ?? 0x95a5a6 }] },
            }),
        });
        break;
      }
      case "webhook": {
        const c = need(env, "NOTIFY_WEBHOOK_URL");
        if (!c) break;
        backends.push({ name, send: (n) => post(c.NOTIFY_WEBHOOK_URL!, { json: n }) });
        break;
      }
      default:
        console.warn(`[WARN] Service de notification inconnu : ${name}`);
    }
  }
  return backends;
}

/** Envoie toutes les notifications ; un échec d'envoi ne fait jamais échouer la synchro. */
export async function sendAll(backends: Backend[], notices: Notice[], opts: { dryRun?: boolean } = {}): Promise<void> {
  for (const n of notices) {
    console.log(`[NOTIF] ${n.title} — ${n.body.replace(/\n/g, " | ")}`);
    if (opts.dryRun) continue;
    for (const b of backends) {
      try {
        await b.send(n);
      } catch (e) {
        console.warn(`[WARN] Échec de la notification ${b.name} : ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
