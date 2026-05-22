import type { QuestionInfo } from "@opencode-ai/sdk/v2";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type QuestionAnswer = string[];

export interface AwaitingCustomAnswer {
  shortHash: string;
  questionIndex: number;
  chatId: number;
  userId: number;
  promptMessageId: number;
}

export interface PendingQuestionState {
  requestID: string;
  sessionID: string;
  questions: QuestionInfo[];
  sentAt: number;
  expiresAt: number;
  telegramMessageIds: number[];
  currentQuestionIndex: number;
  answersInProgress: Array<QuestionAnswer | null>;
  awaitingCustomFor?: AwaitingCustomAnswer;
}

export interface PendingQuestionStoreOptions {
  tokenHash: string;
  baseDir?: string;
}

export interface PendingQuestionStore {
  dir: string;
  savePending(shortHash: string, data: PendingQuestionState): Promise<void>;
  loadPending(shortHash: string): Promise<PendingQuestionState | undefined>;
  deletePending(shortHash: string): Promise<void>;
  sweepExpired(): Promise<PendingQuestionState[]>;
  findByRequestID(requestID: string): Promise<{ shortHash: string; data: PendingQuestionState } | undefined>;
  findAwaitingCustom(chatId: number, userId: number): Promise<{ shortHash: string; data: PendingQuestionState } | undefined>;
}

function hasCode(err: Error, code: string): boolean {
  return "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function pendingFilePath(dir: string, shortHash: string): string {
  return join(dir, `${shortHash}.json`);
}

function parsePending(text: string): PendingQuestionState {
  const parsed = JSON.parse(text) as PendingQuestionState;
  if (typeof parsed.requestID !== "string") throw new Error("Invalid pending question: requestID");
  if (typeof parsed.sessionID !== "string") throw new Error("Invalid pending question: sessionID");
  if (!Array.isArray(parsed.questions)) throw new Error("Invalid pending question: questions");
  if (!Array.isArray(parsed.telegramMessageIds)) throw new Error("Invalid pending question: telegramMessageIds");
  if (!Array.isArray(parsed.answersInProgress)) throw new Error("Invalid pending question: answersInProgress");
  parsed.answersInProgress = parsed.answersInProgress.map((answer) => answer ?? null);
  return parsed;
}

async function listPendingFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Error && hasCode(err, "ENOENT")) return [];
    throw err;
  }
}

function shortHashFromFileName(fileName: string): string {
  return fileName.slice(0, -".json".length);
}

export function createPendingQuestionStore(opts: PendingQuestionStoreOptions): PendingQuestionStore {
  const dir = opts.baseDir ?? join(tmpdir(), `opencoder-telegram-pending-questions-${opts.tokenHash}`);

  return {
    dir,
    async savePending(shortHash, data) {
      const filePath = pendingFilePath(dir, shortHash);
      await mkdir(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
      await rename(tmpPath, filePath);
    },
    async loadPending(shortHash) {
      try {
        return parsePending(await readFile(pendingFilePath(dir, shortHash), "utf8"));
      } catch (err) {
        if (err instanceof Error && hasCode(err, "ENOENT")) return undefined;
        throw err;
      }
    },
    async deletePending(shortHash) {
      try {
        await unlink(pendingFilePath(dir, shortHash));
      } catch (err) {
        if (!(err instanceof Error) || !hasCode(err, "ENOENT")) throw err;
      }
    },
    async sweepExpired() {
      const expired: PendingQuestionState[] = [];
      for (const fileName of await listPendingFiles(dir)) {
        const shortHash = shortHashFromFileName(fileName);
        const data = await this.loadPending(shortHash);
        if (data && data.expiresAt < Date.now()) {
          expired.push(data);
          await this.deletePending(shortHash);
        }
      }
      return expired;
    },
    async findByRequestID(requestID) {
      for (const fileName of await listPendingFiles(dir)) {
        const shortHash = shortHashFromFileName(fileName);
        const data = await this.loadPending(shortHash);
        if (data?.requestID === requestID) return { shortHash, data };
      }
      return undefined;
    },
    async findAwaitingCustom(chatId, userId) {
      for (const fileName of await listPendingFiles(dir)) {
        const shortHash = shortHashFromFileName(fileName);
        const data = await this.loadPending(shortHash);
        const awaiting = data?.awaitingCustomFor;
        if (awaiting && awaiting.chatId === chatId && awaiting.userId === userId) return { shortHash, data };
      }
      return undefined;
    },
  };
}

export function createQuestionShortHash(requestID: string): string {
  return createHash("sha256").update(requestID).digest("base64url").slice(0, 10);
}
