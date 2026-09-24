import { z } from "zod";
import { config } from "./config";

const { limits } = config;

export const chunkSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(limits.maxChunkChars),
  source: z.string().max(300).optional(),
});

export const chatRequestSchema = z.object({
  app_id: z.string().min(1).max(100),
  user_message: z.string().min(1).max(limits.maxUserMessageChars),
  context_chunks: z.array(chunkSchema).max(limits.maxChunks).default([]),
  system_prompt: z.string().max(4000).optional(),
  options: z
    .object({
      force_tier: z.enum(["cheap", "strong"]).nullable().default(null),
      dry_run: z.boolean().default(false),
      // "none" skips screening, for measuring the app without the gateway's protection.
      classifier: z.enum(["jev", "none"]).default("jev"),
    })
    .default({ force_tier: null, dry_run: false, classifier: "jev" }),
});

export type Chunk = z.infer<typeof chunkSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
