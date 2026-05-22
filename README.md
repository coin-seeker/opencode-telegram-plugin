# OpenCode Telegram Notification Plugin

Get OpenCode notifications via Telegram when your agent finishes a task or needs your attention.

> **Disclaimer:** This project is not affiliated with, endorsed by, or sponsored by OpenCode, SST, or any of their affiliates. OpenCode is a trademark of SST.

## Features

- 🔔 **Task Completion Notifications**: Get notified when the OpenCode agent goes idle (task done)
- 🔐 **Permission Alerts**: Receive a ping when OpenCode is waiting on a permission decision
- 🔒 **Multi-Session Safe**: File-lock leader/pass-through model prevents duplicate Telegram polling across concurrent OpenCode windows
- 🔐 **Secure**: Whitelist-based user access control
- 💬 **Simple Setup**: Automatic chat discovery and configuration
- 🪵 **Clean Terminals**: All plugin logs go to a temp file, never to stdout

## Requirements

- Node.js 18+
- OpenCode CLI installed
- Telegram Bot (from [@BotFather](https://t.me/BotFather))

## Installation

### 1. Create a Telegram Bot

1. Talk to [@BotFather](https://t.me/BotFather)
2. Create a new bot with `/newbot`
3. Save the bot token

### 2. Start a Private Chat with the Bot

1. Open your bot in Telegram
2. Tap **Start**
3. Send any message to establish the chat

### 3. Get Your User ID

1. Send any message to [@userinfobot](https://t.me/userinfobot)
2. Save your numeric user ID

### 4. Clone and Build

```bash
git clone https://github.com/YOUR_USERNAME/opencoder-telegram-plugin.git
cd opencoder-telegram-plugin/plugin
npm install
npm run build
```

### 5. Create the `.env` File

The `.env` file lives in the **repo root** (one level above `plugin/`). The plugin auto-discovers it via `import.meta.url` at runtime.

```bash
# opencoder-telegram-plugin/.env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
# Optional: skip the first-message discovery step
# TELEGRAM_CHAT_ID=your_chat_id_here
```

### 6. Register the Plugin with OpenCode

Open `~/.config/opencode/opencode.json` and add the built file to the `plugin` array using a `file://` URL:

```json
{
  "plugin": [
    "oh-my-openagent@latest",
    "file:///Users/yourname/workspace/opencode-plugins/opencode-telegram-plugin/plugin/dist/telegram-remote.js"
  ]
}
```

The `plugin` key is a **singular string array**. Each entry is either an npm package name or a `file://` absolute path. There is no `plugins` (plural) key and no `{name, path}` object format.

## Architecture: Multi-Session Safety

OpenCode often runs in multiple terminal windows at the same time. Without coordination, each window would start its own Telegram long-poll loop, causing duplicate notifications and Telegram API conflicts.

The plugin uses a **file-lock leader/pass-through model** to solve this:

### Leader Process

The first OpenCode process to start acquires an exclusive lock file at:

```
${os.tmpdir()}/opencoder-telegram-<sha256(token).slice(0,16)>.lock
```

The lock file contains the owning process's PID. The leader is the only process that runs the Telegram polling loop and receives incoming messages.

### Pass-Through Processes

Any subsequent OpenCode process detects the existing lock and enters **pass-through mode**. Pass-through processes:

- Do **not** start a polling loop
- Can still send outbound Telegram notifications via `bot.api.sendMessage`
- Read the active chat ID from the shared state file (see below)

### Stale Lock Recovery

If the lock file is older than 5 minutes, or the PID it contains is no longer running, any process can reclaim the lock and become the new leader.

### Shared State

The active chat ID is persisted to:

```
~/.config/opencode/telegram-remote/state.json
```

This lets pass-through processes send notifications even before the user has messaged the bot in the current leader's session.

## Usage

### Initial Setup

1. Start OpenCode with the plugin registered
2. Open your Telegram bot and send any message (e.g., "Hello")
3. The bot replies with your chat ID and confirms the connection
4. You're ready to receive notifications

### Notification Triggers

The plugin sends a Telegram message when these OpenCode events fire:

| Event | When it fires | Message sent |
|-------|--------------|--------------|
| `session.idle` | Agent finishes a task | `Agent has finished: [Session Title]` |
| `permission.updated` | OpenCode is waiting on a permission decision | `Permission needed: [Session Title]` |

The `session.updated` event is also consumed internally to keep session titles up to date for the notification messages.

### Optional: Pre-configure Chat ID

Add your chat ID to `.env` to skip the first-message discovery step:

```bash
TELEGRAM_CHAT_ID=your_chat_id_here
```

You can get your chat ID by messaging the bot once, or using [@userinfobot](https://t.me/userinfobot).

## Configuration Reference

### Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather | `123456:ABC-DEF...` |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes | Comma-separated numeric user IDs | `123456789,987654321` |
| `TELEGRAM_CHAT_ID` | No | Pre-configured chat ID (skips discovery) | `123456789` |

### OpenCode Plugin Configuration

The correct schema uses `"plugin"` (singular) with string entries:

```json
{
  "plugin": [
    "file:///absolute/path/to/telegram-remote.js"
  ]
}
```

Example for macOS (replace `<your-username>` and the clone path with your own):

```json
{
  "plugin": [
    "file:///Users/<your-username>/path/to/opencode-telegram-plugin/plugin/dist/telegram-remote.js"
  ]
}
```

> Find your absolute path with `pwd` from inside the cloned repo, then append `/plugin/dist/telegram-remote.js`.

## Security

### Access Control

- Only whitelisted user IDs can interact with the bot
- The whitelist is comma-separated in `.env`
- Non-whitelisted users are silently ignored

### Best Practices

1. Use a **private** chat with the bot (not a group)
2. Keep the bot token secret and out of version control
3. Only add trusted users to the whitelist
4. Check `.env` file permissions: `chmod 600 .env`

## Troubleshooting

### Bot doesn't send notifications

- Verify the bot token is correct in `.env`
- Confirm your user ID is in `TELEGRAM_ALLOWED_USER_IDS`
- Make sure you've sent at least one message to the bot to establish the chat
- Check the plugin log file (see below)

### Duplicate notifications

- This shouldn't happen with the leader/pass-through model, but if it does, check whether a stale lock file exists at `${os.tmpdir()}/opencoder-telegram-<hash>.lock` and delete it

### Chat not connecting

- Make sure you're using a **private** chat (not a group)
- Send any message to the bot to trigger chat discovery
- If using `TELEGRAM_CHAT_ID` in `.env`, verify the ID is correct

### Permission denied

- Your user ID must be in `TELEGRAM_ALLOWED_USER_IDS`
- Use [@userinfobot](https://t.me/userinfobot) to verify your numeric user ID (not username)

### Checking Logs

The plugin writes all diagnostic output to a buffered log file. It never writes to stdout, so your OpenCode terminal stays clean.

**Log file:**
```
${os.tmpdir()}/opencoder-telegram.log
# macOS example: /var/folders/.../opencoder-telegram.log
```

**Lock file** (one per bot token):
```
${os.tmpdir()}/opencoder-telegram-<sha256(token).slice(0,16)>.lock
```

**State file** (persists active chat ID across sessions):
```
~/.config/opencode/telegram-remote/state.json
```

To tail the log in real time:
```bash
tail -f $(ls /tmp/opencoder-telegram.log 2>/dev/null || echo "/var/folders/*/opencoder-telegram.log")
```

Or on macOS, find the exact path with:
```bash
node -e "const os=require('os'); console.log(os.tmpdir() + '/opencoder-telegram.log')"
```

## Development

### Project Structure

```
opencoder-telegram-plugin/
├── .env                              # Bot credentials (repo root, gitignored)
├── .env.example                      # Template for .env
├── plugin/
│   ├── src/
│   │   ├── telegram-remote.ts        # Plugin entry point, event routing
│   │   ├── bot.ts                    # Grammy bot setup and manager
│   │   ├── config.ts                 # Config loading (via env-loader)
│   │   ├── events/
│   │   │   ├── session-idle.ts       # Handles session.idle → notification
│   │   │   ├── session-updated.ts    # Tracks session titles
│   │   │   ├── permission-updated.ts # Handles permission.updated → notification
│   │   │   ├── types.ts              # Shared TypeScript types
│   │   │   └── index.ts              # Re-exports all handlers
│   │   ├── lib/
│   │   │   ├── lock.ts               # File-lock leader election
│   │   │   ├── claim.ts              # Per-event cross-process dedup
│   │   │   ├── state-store.ts        # Atomic JSON state persistence
│   │   │   ├── logger.ts             # Buffered file logger
│   │   │   └── env-loader.ts         # Multi-source .env loader
│   │   └── services/
│   │       └── session-title-service.ts  # In-memory session title cache
│   ├── dist/                         # Built output (gitignored)
│   ├── package.json
│   ├── tsconfig.json
│   └── tsup.config.ts
```

### Build

```bash
cd plugin
npm run build      # Production build
npm run dev        # Watch mode
npm run typecheck  # Type checking only
```

### Testing Locally

1. Build the plugin: `npm run build`
2. Make sure `.env` exists in the repo root with valid credentials
3. Add the `file://` path to your `~/.config/opencode/opencode.json`
4. Start OpenCode and message the bot to establish the connection
5. Run an OpenCode task and wait for the idle notification

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run lint` and `npm run build`
5. Submit a pull request

## License

MIT
