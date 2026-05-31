import { createHash } from "node:crypto";
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface ClaimOptions {
  claimsDir: string;
  key: string;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;
const sweptDirs = new Set<string>();

function hasCode(err: Error, code: string): boolean {
  return "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function claimPath(claimsDir: string, key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(claimsDir, `${hash}.claim`);
}

async function sweep(claimsDir: string, ttlMs: number): Promise<void> {
  if (sweptDirs.has(claimsDir)) return;
  sweptDirs.add(claimsDir);
  try {
    const entries = await readdir(claimsDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".claim"))
        .map(async (entry) => {
          const filePath = join(claimsDir, entry.name);
          try {
            const fileStat = await stat(filePath);
            if (Date.now() - fileStat.mtimeMs > ttlMs * 2) {
              await unlink(filePath);
            }
          } catch {
            // best-effort sweep
          }
        }),
    );
  } catch {
    // directory may not exist yet
  }
}

async function createClaim(filePath: string): Promise<boolean> {
  const file = await open(filePath, "wx");
  try {
    await file.writeFile(new Date().toISOString(), "utf8");
  } finally {
    await file.close();
  }
  return true;
}

export async function claimOnce(opts: ClaimOptions): Promise<boolean> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  await mkdir(opts.claimsDir, { recursive: true });
  await sweep(opts.claimsDir, ttlMs);
  const filePath = claimPath(opts.claimsDir, opts.key);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await createClaim(filePath);
    } catch (err) {
      if (!(err instanceof Error) || !hasCode(err, "EEXIST")) throw err;
      try {
        const fileStat = await stat(filePath);
        if (Date.now() - fileStat.mtimeMs <= ttlMs || attempt === 1) return false;
        await unlink(filePath);
      } catch (statErr) {
        if (statErr instanceof Error && hasCode(statErr, "ENOENT")) continue;
        return false;
      }
    }
  }
  return false;
}

export async function releaseClaim(opts: ClaimOptions): Promise<void> {
  try {
    await unlink(claimPath(opts.claimsDir, opts.key));
  } catch (err) {
    if (!(err instanceof Error) || !hasCode(err, "ENOENT")) throw err;
  }
}
