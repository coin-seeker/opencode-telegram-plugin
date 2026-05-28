import type { Session } from "@opencode-ai/sdk";

export type SessionWithAgent = Session & { agent?: string };
