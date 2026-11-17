export type NoticeKind = "new" | "rescheduled" | "updated" | "result" | "removed" | "digest" | "error" | "fallback" | "test";

export type Notice = {
  kind: NoticeKind;
  title: string;
  body: string;
  /** Lien ouvert au tap sur la notification. */
  url?: string;
  priority: "low" | "default" | "high";
  /** Données structurées du match (webhook, Pushcut → Raccourcis). */
  match?: Record<string, unknown>;
};

export type Backend = {
  name: string;
  send(n: Notice): Promise<void>;
};
