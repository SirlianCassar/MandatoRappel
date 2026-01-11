import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { StateV1 } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const StateSchema: z.ZodType<StateV1> = z.object({
  version: z.literal(1),
  events: z.record(
    z.object({
      href: z.string().url(),
      etag: z.string().optional(),
      uid: z.string(),
      matchId: z.string(),
      payload: z.object({
        summary: z.string(),
        location: z.string(),
        description: z.string(),
        officialStartUtcIso: z.string().optional(),
        officialEndUtcIso: z.string().optional(),
        startUtcIso: z.string(),
        endUtcIso: z.string(),
        alarms: z.object({
          minus1Hour: z.boolean(),
          minus1Day: z.boolean(),
        }),
      }),
      lastSeenUtcIso: z.string(),
    })
  ),
  matchIdIndex: z.record(
    z.object({
      eventKey: z.string(),
      lastSeenUtcIso: z.string(),
    })
  ),
});

export const DEFAULT_STATE_PATH = path.resolve(__dirname, "..", "data", "state.json");

export async function readState(statePath = DEFAULT_STATE_PATH): Promise<StateV1> {
  const raw = await fs.readFile(statePath, "utf8").catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return JSON.stringify({ version: 1, events: {}, matchIdIndex: {} });
    }
    throw err;
  });
  const json = JSON.parse(raw) as unknown;
  const parsed = StateSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`État invalide dans ${statePath}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function writeState(state: StateV1, statePath = DEFAULT_STATE_PATH): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}


