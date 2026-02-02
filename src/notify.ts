/**
 * Module de notifications push pour les événements créés/modifiés.
 * Supporte plusieurs backends : Telegram, Discord, Email SMTP, Pushover.
 */

type NotificationBackend = "telegram" | "discord" | "email" | "pushover" | "pushcut" | "webhook" | "none";

interface NotificationConfig {
  backend: NotificationBackend;
  telegram?: { botToken: string; chatId: string };
  discord?: { webhookUrl: string };
  email?: { smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; to: string; from: string };
  pushover?: { apiToken: string; userKey: string };
  pushcut?: { apiKey: string; notificationKey: string };
  webhook?: { url: string };
}

interface NotificationPayload {
  title: string;
  message: string;
  created?: number;
  updated?: number;
  unchanged?: number;
}

async function sendTelegram(config: NonNullable<NotificationConfig["telegram"]>, payload: NotificationPayload): Promise<void> {
  const text = `*${payload.title}*\n\n${payload.message}`;
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API error: ${response.status} ${body}`);
  }
}

async function sendDiscord(config: NonNullable<NotificationConfig["discord"]>, payload: NotificationPayload): Promise<void> {
  const content = `**${payload.title}**\n\n${payload.message}`;
  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      username: "MDR Calendar Sync",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook error: ${response.status} ${body}`);
  }
}

async function sendPushover(config: NonNullable<NotificationConfig["pushover"]>, payload: NotificationPayload): Promise<void> {
  const message = `${payload.title}\n\n${payload.message}`;
  const formData = new URLSearchParams({
    token: config.apiToken,
    user: config.userKey,
    title: payload.title,
    message,
    priority: "0", // Normal priority
  });

  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Pushover API error: ${response.status} ${body}`);
  }
}

async function sendPushcut(config: NonNullable<NotificationConfig["pushcut"]>, payload: NotificationPayload): Promise<void> {
  const message = `${payload.title}\n\n${payload.message}`;
  const url = `https://api.pushcut.io/v1/notifications/${config.notificationKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "API-Key": config.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: payload.title,
      text: message,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Pushcut API error: ${response.status} ${body}`);
  }
}

async function sendWebhook(config: NonNullable<NotificationConfig["webhook"]>, payload: NotificationPayload): Promise<void> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: payload.title,
      message: payload.message,
      created: payload.created,
      updated: payload.updated,
      unchanged: payload.unchanged,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Webhook error: ${response.status} ${body}`);
  }
}

export async function sendNotification(config: NotificationConfig, payload: NotificationPayload): Promise<void> {
  if (config.backend === "none" || !config.backend) {
    return; // Notifications désactivées
  }

  try {
    switch (config.backend) {
      case "telegram":
        if (!config.telegram) throw new Error("Telegram config manquante");
        await sendTelegram(config.telegram, payload);
        break;
      case "discord":
        if (!config.discord) throw new Error("Discord config manquante");
        await sendDiscord(config.discord, payload);
        break;
      case "pushover":
        if (!config.pushover) throw new Error("Pushover config manquante");
        await sendPushover(config.pushover, payload);
        break;
      case "pushcut":
        if (!config.pushcut) throw new Error("Pushcut config manquante");
        await sendPushcut(config.pushcut, payload);
        break;
      case "webhook":
        if (!config.webhook) throw new Error("Webhook config manquante");
        await sendWebhook(config.webhook, payload);
        break;
      case "email":
        // Email SMTP implémenté plus tard si besoin
        console.warn("[WARN] Email SMTP pas encore implémenté");
        break;
      default:
        console.warn(`[WARN] Backend de notification inconnu: ${config.backend}`);
    }
  } catch (error) {
    // On log l'erreur mais on ne fait pas échouer le script si les notifications échouent
    console.warn(`[WARN] Échec envoi notification (${config.backend}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Parse la configuration depuis les variables d'environnement.
 * Format attendu :
 * - NOTIFY_BACKEND: "telegram" | "discord" | "pushover" | "pushcut" | "webhook" | "none" (défaut: "none")
 * - NOTIFY_TELEGRAM_BOT_TOKEN: token du bot Telegram
 * - NOTIFY_TELEGRAM_CHAT_ID: chat_id Telegram
 * - NOTIFY_DISCORD_WEBHOOK_URL: URL du webhook Discord
 * - NOTIFY_PUSHOVER_API_TOKEN: API token Pushover
 * - NOTIFY_PUSHOVER_USER_KEY: User key Pushover
 * - NOTIFY_PUSHCUT_API_KEY: API key Pushcut
 * - NOTIFY_PUSHCUT_NOTIFICATION_KEY: Notification key Pushcut
 * - NOTIFY_WEBHOOK_URL: URL du webhook générique
 */
export function parseNotificationConfig(): NotificationConfig {
  const backend = (process.env.NOTIFY_BACKEND || "none").toLowerCase() as NotificationBackend;

  if (backend === "none" || !backend) {
    return { backend: "none" };
  }

  const config: NotificationConfig = { backend };

  if (backend === "telegram") {
    const botToken = process.env.NOTIFY_TELEGRAM_BOT_TOKEN;
    const chatId = process.env.NOTIFY_TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) {
      console.warn("[WARN] Telegram config incomplète (NOTIFY_TELEGRAM_BOT_TOKEN, NOTIFY_TELEGRAM_CHAT_ID requis)");
      return { backend: "none" };
    }
    config.telegram = { botToken, chatId };
  } else if (backend === "discord") {
    const webhookUrl = process.env.NOTIFY_DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      console.warn("[WARN] Discord config incomplète (NOTIFY_DISCORD_WEBHOOK_URL requis)");
      return { backend: "none" };
    }
    config.discord = { webhookUrl };
  } else if (backend === "pushover") {
    const apiToken = process.env.NOTIFY_PUSHOVER_API_TOKEN;
    const userKey = process.env.NOTIFY_PUSHOVER_USER_KEY;
    if (!apiToken || !userKey) {
      console.warn("[WARN] Pushover config incomplète (NOTIFY_PUSHOVER_API_TOKEN, NOTIFY_PUSHOVER_USER_KEY requis)");
      return { backend: "none" };
    }
    config.pushover = { apiToken, userKey };
  } else if (backend === "pushcut") {
    const apiKey = process.env.NOTIFY_PUSHCUT_API_KEY;
    const notificationKey = process.env.NOTIFY_PUSHCUT_NOTIFICATION_KEY;
    if (!apiKey || !notificationKey) {
      console.warn("[WARN] Pushcut config incomplète (NOTIFY_PUSHCUT_API_KEY, NOTIFY_PUSHCUT_NOTIFICATION_KEY requis)");
      return { backend: "none" };
    }
    config.pushcut = { apiKey, notificationKey };
  } else if (backend === "webhook") {
    const url = process.env.NOTIFY_WEBHOOK_URL;
    if (!url) {
      console.warn("[WARN] Webhook config incomplète (NOTIFY_WEBHOOK_URL requis)");
      return { backend: "none" };
    }
    config.webhook = { url };
  }

  return config;
}
