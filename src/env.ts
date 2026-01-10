import { z } from "zod";

const EnvSchema = z.object({
  ICLOUD_USERNAME: z.string().min(1),
  ICLOUD_APP_PASSWORD: z.string().min(1),
  TEAM_NAME: z.string().min(1),
  // Optionnel mais utile en pratique (sans casser les exigences)
  ICLOUD_CALENDAR_NAME: z.string().optional(),
  DRY_RUN: z.string().optional(),
  FORCE_RUN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema> & {
  dryRun: boolean;
  forceRun: boolean;
};

export function readEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Variables d'environnement invalides:\n${issues}`);
  }
  return {
    ...parsed.data,
    dryRun: parsed.data.DRY_RUN === "1" || parsed.data.DRY_RUN === "true",
    forceRun: parsed.data.FORCE_RUN === "1" || parsed.data.FORCE_RUN === "true",
  };
}


