import { z } from "zod";

const EnvSchema = z.object({
  ICLOUD_USERNAME: z.string().min(1),
  ICLOUD_APP_PASSWORD: z.string().min(1),
  TEAM_NAME: z.string().min(1),
  // Optionnel mais utile en pratique (sans casser les exigences)
  ICLOUD_CALENDAR_NAME: z.string().optional(),
  DRY_RUN: z.string().optional(),
  FORCE_RUN: z.string().optional(),
  DEBUG_SCRAPE: z.string().optional(),
  USE_LIQUIPEDIA: z.string().optional(),
  LIQUIPEDIA_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema> & {
  dryRun: boolean;
  forceRun: boolean;
  debugScrape: boolean;
  useLiquipedia: boolean;
};

function isTruthy(value?: string): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

export function readEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Variables d'environnement invalides:\n${issues}`);
  }
  return {
    ...parsed.data,
    dryRun: isTruthy(parsed.data.DRY_RUN),
    forceRun: isTruthy(parsed.data.FORCE_RUN),
    debugScrape: isTruthy(parsed.data.DEBUG_SCRAPE),
    useLiquipedia: isTruthy(parsed.data.USE_LIQUIPEDIA),
  };
}

