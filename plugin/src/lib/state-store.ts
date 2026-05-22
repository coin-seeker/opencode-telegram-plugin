import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface TelegramState {
  chatId?: number;
  updatedAt?: string;
  discoveredBy?: number;
}

export interface StateStoreOptions {
  filePath?: string;
}

export interface StateStore {
  read(): Promise<TelegramState>;
  write(patch: Partial<TelegramState>): Promise<TelegramState>;
}

function hasCode(err: Error, code: string): boolean {
  return "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function parseState(text: string): TelegramState {
  const parsed = JSON.parse(text) as Partial<TelegramState>;
  const state: TelegramState = {};
  if (typeof parsed.chatId === "number") state.chatId = parsed.chatId;
  if (typeof parsed.updatedAt === "string") state.updatedAt = parsed.updatedAt;
  if (typeof parsed.discoveredBy === "number") state.discoveredBy = parsed.discoveredBy;
  return state;
}

export function createStateStore(opts: StateStoreOptions = {}): StateStore {
  const filePath = opts.filePath ?? join(homedir(), ".config/opencode/telegram-remote/state.json");

  return {
    async read() {
      try {
        return parseState(await readFile(filePath, "utf8"));
      } catch (err) {
        if (err instanceof Error && hasCode(err, "ENOENT")) return {};
        throw err;
      }
    },
    async write(patch) {
      const existing = await this.read();
      const next: TelegramState = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      await mkdir(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
      try {
        await rename(tmpPath, filePath);
      } catch (err) {
        if (!(err instanceof Error) || !hasCode(err, "ENOENT")) throw err;
        await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
        await rename(tmpPath, filePath);
      }
      return next;
    },
  };
}
