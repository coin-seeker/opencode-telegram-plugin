import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/telegram-remote.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk", "@opencode-ai/sdk/v2", "grammy"],
  banner: {
    js: `/**
 * OpenCoder Telegram Remote Plugin
 * https://github.com/YOUR_USERNAME/opencoder-telegram-remote-plugin
 */`,
  },
});
