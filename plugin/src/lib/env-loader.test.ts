import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { loadPluginEnv } from "./env-loader.js";

const ENV_KEYS = ["A", "B", "C", "D", "SHARED"];

describe("loadPluginEnv", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `test-${randomUUID()}`));
  });

  after(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    await rm(dir, { recursive: true, force: true });
  });

  test("loads existing env files in lookup order without override", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const pluginDir = join(dir, "repo", "plugin", "dist");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(dir, "repo", ".env"), "A=repo\nSHARED=first\n", "utf8");
    await writeFile(join(dir, "repo", "plugin", ".env"), "B=plugin\nSHARED=second\n", "utf8");
    await writeFile(join(pluginDir, ".env"), "C=dist\n", "utf8");
    const result = loadPluginEnv({ pluginDir, homeDir: join(dir, "home") });
    assert.equal(result.loadedFrom.length, 3);
    assert.equal(result.values.A, "repo");
    assert.equal(result.values.B, "plugin");
    assert.equal(result.values.C, "dist");
    assert.equal(process.env.SHARED, "first");
  });

  test("returns empty result for ENOENT paths", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const result = loadPluginEnv({ pluginDir: join(dir, "none"), homeDir: join(dir, "home-none") });
    assert.deepEqual(result, { loadedFrom: [], values: {} });
  });

  test("does not override existing process env", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.D = "existing";
    const pluginDir = join(dir, "override");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, ".env"), "D=file\n", "utf8");
    const result = loadPluginEnv({ pluginDir, homeDir: join(dir, "home-override") });
    assert.equal(result.values.D, "file");
    assert.equal(process.env.D, "existing");
  });

  test("handles duplicate path conflict simulation", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const pluginDir = dir;
    await writeFile(join(dir, ".env"), "A=same\n", "utf8");
    const result = loadPluginEnv({ pluginDir, homeDir: join(dir, "home-duplicate") });
    assert.ok(result.loadedFrom.length >= 1);
    assert.equal(result.values.A, "same");
  });
});
