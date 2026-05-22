import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LoggerOptions {
  filePath?: string;
  namespace?: string;
  bufferLimit?: number;
  flushIntervalMs?: number;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const DEFAULT_BUFFER_LIMIT = 4096;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;

function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    return "{\"serialization\":\"failed\"}";
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const filePath = opts.filePath ?? `${tmpdir()}/opencoder-telegram.log`;
  const namespace = opts.namespace ?? "default";
  const bufferLimit = opts.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  let buffer = "";
  let closed = false;
  let flushing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    void flushBuffer();
  }, flushIntervalMs);
  timer.unref();

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0) return flushing;
    const chunk = buffer;
    buffer = "";
    flushing = flushing.then(async () => {
      try {
        await appendFile(filePath, chunk, "utf8");
      } catch {
        // Logging must never break plugin execution.
      }
    });
    return flushing;
  }

  function write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (closed) return;
    const json = data === undefined ? "" : ` ${safeJson(data)}`;
    buffer += `[${new Date().toISOString()}] [${level}] [${process.pid}] [${namespace}] ${msg}${json}\n`;
    if (level === "error" || buffer.length >= bufferLimit) {
      void flushBuffer();
    }
  }

  return {
    debug(msg, data) {
      write("debug", msg, data);
    },
    info(msg, data) {
      write("info", msg, data);
    },
    warn(msg, data) {
      write("warn", msg, data);
    },
    error(msg, data) {
      write("error", msg, data);
    },
    async flush() {
      await flushBuffer();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await flushBuffer();
    },
  };
}
