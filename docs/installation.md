# OpenCode Telegram Plugin Installation

Use this guide to install `@coinseeker/opencode-telegram-plugin@1.1.8` as an OpenCode npm package plugin.

## For AI Coding Agents

If you are an AI coding agent installing this for a user, follow these rules:

1. Ask the user for these values before editing files:
   - Telegram bot token from BotFather: `TELEGRAM_BOT_TOKEN`
   - Allowed Telegram numeric user ID(s): `TELEGRAM_ALLOWED_USER_IDS`
   - Optional Telegram chat ID: `TELEGRAM_CHAT_ID`
2. Never print, summarize, commit, or upload the bot token.
3. Never commit `.env`, `.env.local`, or any file containing Telegram credentials.
4. Store credentials in `~/.config/opencode/telegram-remote/.env` with `chmod 600`.
5. Preserve existing OpenCode plugins in `opencode.json`; append this plugin instead of replacing the whole array.
6. After editing config, tell the user to restart OpenCode.

Copy this prompt into an AI coding agent if you want it to install the plugin:

```text
Install OpenCode Telegram Plugin from npm.

Package: @coinseeker/opencode-telegram-plugin@1.1.8

Before modifying files, ask me for:
- TELEGRAM_BOT_TOKEN
- TELEGRAM_ALLOWED_USER_IDS
- optional TELEGRAM_CHAT_ID

Then:
1. Create ~/.config/opencode/telegram-remote/.env with the provided Telegram values.
2. chmod 600 ~/.config/opencode/telegram-remote/.env.
3. Add "@coinseeker/opencode-telegram-plugin@1.1.8" to ~/.config/opencode/opencode.json under the singular "plugin" array, preserving existing plugins.
4. Do not commit .env or any secrets.
5. Show me the final non-secret config path and ask me to restart OpenCode.
```

## Manual Install

### 1. Configure Telegram Credentials

Create the plugin env file:

```bash
mkdir -p ~/.config/opencode/telegram-remote
chmod 700 ~/.config/opencode/telegram-remote
cat > ~/.config/opencode/telegram-remote/.env <<'EOF'
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
# Optional: skip first-message discovery
# TELEGRAM_CHAT_ID=123456789
EOF
chmod 600 ~/.config/opencode/telegram-remote/.env
```

You can get your numeric Telegram user ID from [@userinfobot](https://t.me/userinfobot).

### 2. Register the Plugin in OpenCode

Open `~/.config/opencode/opencode.json` and append the pinned npm package name:

```json
{
  "plugin": [
    "@coinseeker/opencode-telegram-plugin@1.1.8"
  ]
}
```

If `plugin` already exists, keep its existing entries and add this one. The key is `plugin`, not `plugins`.

### 3. Restart and Connect Telegram

1. Restart OpenCode.
2. Open a private chat with your Telegram bot.
3. Send any message to the bot.
4. The bot should reply with a connection confirmation.
5. Run an OpenCode task and confirm Telegram notifications arrive.

For OpenCode questions, tap an inline option to answer. For multi-select questions, tap options to toggle them and then tap **Done**.

For OpenCode permission prompts, use the Telegram inline buttons to **Allow once**, **Always allow**, or **Reject**.

## Updating an Existing npm Install

Open `~/.config/opencode/opencode.json` and replace the old pinned package entry with the current version:

```json
{
  "plugin": [
    "@coinseeker/opencode-telegram-plugin@1.1.8"
  ]
}
```

If the `plugin` array has other entries, keep them unchanged. Restart OpenCode after saving because npm package plugins are resolved only when OpenCode starts.

## Local Clone Development

Use this only when developing the plugin or testing unreleased source changes.

### 1. Clone and Build

Choose where to keep the clone. The clone must stay in that location because OpenCode loads the built plugin via an absolute `file://` path.

```bash
git clone https://github.com/coin-seeker/opencode-telegram-plugin.git
cd opencode-telegram-plugin
npm install
cd plugin
npm install
npm run build
```

### 2. Create a Dev `.env`

Return to the repository root and create `.env`:

```bash
cd ..
cp .env.example .env
chmod 600 .env
```

Edit `.env` with your Telegram values:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
# Optional: skip first-message discovery
# TELEGRAM_CHAT_ID=123456789
```

### 3. Register the Built File

Open `~/.config/opencode/opencode.json` and append the built plugin path:

```json
{
  "plugin": [
    "file:///Users/<your-username>/path/to/opencode-telegram-plugin/plugin/dist/telegram-remote.js"
  ]
}
```

## Updating a Local Clone

```bash
cd /absolute/path/to/opencode-telegram-plugin
git pull
npm install
cd plugin
npm install
npm run build
```

Restart OpenCode after rebuilding.

## Verification Commands

From `plugin/`:

```bash
npm run typecheck
npm test
npm run build
```

Check logs:

```bash
node -e "const os=require('os'); console.log(os.tmpdir() + '/opencoder-telegram.log')"
```

## Troubleshooting

### Bot Does Not Reply

- Confirm `TELEGRAM_BOT_TOKEN` is correct.
- Confirm your numeric Telegram user ID is included in `TELEGRAM_ALLOWED_USER_IDS`.
- Use a private chat with the bot, not a group chat.
- Restart OpenCode after changing the env file.

### Plugin Does Not Load

- Confirm the npm package name is exactly `@coinseeker/opencode-telegram-plugin@1.1.8`.
- Confirm the key is `plugin`, not `plugins`.
- Restart OpenCode.

### Telegram Button Replies Fail

- Confirm OpenCode is loading the current npm package version.
- Restart OpenCode after updating the package.
- Check the log for `failed to send question reply`.

### Subagent Notifications Still Arrive

- Update the package and restart OpenCode.
- Check the log for `suppressing child session idle notification`.
- For background subagents, check for `deferring parent idle notification - child sessions still running` followed by `sending deferred parent idle notification`.
