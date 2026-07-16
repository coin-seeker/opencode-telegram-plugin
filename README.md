# OpenCode Telegram Plugin

Control and monitor OpenCode from Telegram. Install it as the npm package `@coinseeker/opencode-telegram-plugin@latest`, then configure your Telegram bot credentials in a private local env file.

> **Disclaimer:** This project is not affiliated with, endorsed by, or sponsored by OpenCode, SST, or any of their affiliates. OpenCode is a trademark of SST.

## Features

- **Task completion notifications**: Receive Telegram messages when the root OpenCode session is truly finished.
- **Subagent-aware completion**: Child/subagent idle events are suppressed, and parent completion is deferred until background subagents finish.
- **Question replies from Telegram**: Answer OpenCode `question` prompts from inline Telegram buttons.
- **Multi-select question replies**: Toggle multiple choices in Telegram and submit them with **Done**.
- **Custom answers**: Use Telegram free-text replies for prompts that allow custom input.
- **Permission alerts**: Receive a ping when OpenCode is waiting on a permission decision.
- **Permission replies from Telegram**: Approve once, always allow, or reject OpenCode permission prompts from Telegram.
- **Multi-session safe**: A file-lock leader/pass-through model prevents duplicate Telegram polling across concurrent OpenCode windows.
- **Clean terminals**: Plugin logs go to a temp file instead of stdout, so OpenCode terminal output stays clean.
- **Access control**: Only whitelisted Telegram user IDs can interact with the bot.

## Requirements

- Node.js 18+
- npm
- OpenCode CLI installed
- Telegram Bot (from [@BotFather](https://t.me/BotFather))

## Installation

Paste below into your OpenCode.

```text
Install and configure OpenCode Telegram Plugin by following the instructions here:
https://raw.githubusercontent.com/coin-seeker/opencode-telegram-plugin/refs/heads/main/docs/installation.md
```

OpenCode installs and loads the npm package on startup.

The `@latest` tag installs the newest published release, so a first-time install never needs a version pin. To see what `@latest` currently points to, run `npm view @coinseeker/opencode-telegram-plugin version`. OpenCode caches each resolved install, so updating an existing copy takes one extra step — see [Updating an Existing npm Install](#updating-an-existing-npm-install).

For a step-by-step manual install guide and an AI-agent-friendly install prompt, see [`docs/installation.md`](docs/installation.md).

### Setup

One env file. One config entry. Restart. Done.

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

### 4. Configure Telegram Credentials

Create `~/.config/opencode/telegram-remote/.env`:

```bash
mkdir -p ~/.config/opencode/telegram-remote
chmod 700 ~/.config/opencode/telegram-remote
cat > ~/.config/opencode/telegram-remote/.env <<'EOF'
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
# Optional: skip the first-message discovery step
# TELEGRAM_CHAT_ID=your_chat_id_here
EOF
chmod 600 ~/.config/opencode/telegram-remote/.env
```

Keep this file private. Never commit or share your Telegram bot token.

### 6. Register the Plugin with OpenCode

Open `~/.config/opencode/opencode.json` and add the pinned npm package name to the `plugin` array:

```json
{
  "plugin": [
    "@coinseeker/opencode-telegram-plugin@latest"
  ]
}
```

The `plugin` key is a **singular string array**. Each entry is either an npm package name or a `file://` absolute path. There is no `plugins` (plural) key and no `{name, path}` object format.

Restart OpenCode after changing this file.

### Updating an Existing npm Install

OpenCode installs the `@latest` entry the first time it resolves the plugin and then **caches that install** under `~/.cache/opencode/packages/`. A plain restart does not pull a newer release, because OpenCode reuses the cached copy instead of re-querying npm. To move an existing install to the newest published release, do one of the following:

- **Refresh the `@latest` cache** — delete the cached package directory, then restart OpenCode:

  ```bash
  rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/@coinseeker/opencode-telegram-plugin@latest"
  ```

- **Or pin an exact version** — set the entry to a specific version (find the newest with `npm view @coinseeker/opencode-telegram-plugin version`). A new version spec is a different cache key, so OpenCode installs it fresh on the next restart.

Keep all other plugin entries unchanged, then restart OpenCode. npm package plugins are resolved only when OpenCode starts, so running sessions keep the previous version until restart.

### 7. Connect Telegram

1. Start OpenCode from any project where the global config is loaded.
2. Send any message to your Telegram bot in a private chat.
3. The bot should reply with a chat connection confirmation.
4. Run an OpenCode task and confirm you receive notifications.

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

### Notification and Reply Triggers

The plugin reacts to these OpenCode events:

| Event | When it fires | Telegram behavior |
|-------|---------------|-------------------|
| `session.status` / `session.idle` | Root session finishes and no child/subagent is running | Sends a `✅ 작업 완료` notice with the session title and agent name (e.g. `build`) when known |
| Child/subagent idle | A subagent finishes | Suppressed; no Telegram completion message |
| Parent idle while background subagent is running | Parent appears idle before background work completes | Defers the parent completion message |
| `permission.updated` | OpenCode is waiting on a permission decision | Sends a `🔐 권한 요청` notice with the session title and permission details |
| `permission.asked` | OpenCode is waiting on a permission decision | Sends approve/reject inline buttons |
| `question.asked` | OpenCode asks an interactive question | Sends Telegram inline buttons and optional custom answer flow |
| `question.replied` | The question was answered elsewhere | Cleans up pending Telegram question state |

The plugin also consumes `session.created` and `session.updated` internally to cache session titles and parent/child relationships.

### Slash Commands

Control OpenCode sessions directly from Telegram.

| Command | Description |
|---------|-------------|
| `/sessions` | List recent root sessions (most-recent first, top 20) |
| `/status <N>` | Show session #N details: agent, status, last messages, plan progress, boulder state |
| `/start_work <N>` | Trigger `/start-work` on session #N (safety-gated) |
| `/help` | Show command reference |

Session numbers come from the most recent `/sessions` call. The mapping snapshot expires after 1 hour — re-run `/sessions` to refresh.

#### Safety Gates for `/start_work`

`/start_work <N>` only dispatches opencode's `/start-work` command when ALL conditions are met:

1. `agent` is `plan`, `prometheus`, or a Prometheus Plan Builder label such as `Prometheus - Plan Builder` — session must be a planning session
2. `status === 'idle'` — re-validated via live API call (TOCTOU-safe)
3. An incomplete `.omo/plans/*.md` plan file exists in the session's project
4. No `.omo/boulder.json` file exists (prevents duplicate execution)

When a condition fails, a specific Korean reason is returned.

#### Cross-Process Visibility

Every OpenCode process writes root-session metadata to a shared local registry under `~/.config/opencode/telegram-remote/session-registry/`. `/sessions` is handled by the **leader process**, but it merges the leader's live session list with that shared registry so recent root sessions from other OpenCode windows are still visible.

> **Note**: Telegram bot commands use underscores: `/start_work` (Telegram) maps internally to opencode's `/start-work` slash command.

### Answering OpenCode Questions from Telegram

When OpenCode asks a question, the bot sends the question with inline buttons.

- Tap an option to answer with that option label.
- For multi-select prompts, tap options to toggle them, then tap **Done** to submit.
- Tap **Custom answer** when available, then reply to the Telegram force-reply prompt with free text.
- Multi-question prompts are handled one question at a time.

### Answering Permission Prompts from Telegram

When OpenCode asks for permission, such as reading a protected `.env` file, the bot sends inline buttons:

- **Allow once** approves only this request.
- **Always allow** approves this request and asks OpenCode to remember the matching rule when supported.
- **Reject** denies the request.

### Interrupts and Background Subagents

- Interrupted sessions are not reported as successful completion notifications.
- Subagent/child session completion notifications are suppressed.
- If a parent session becomes idle while background subagents are still running, the plugin waits and sends one parent completion notification after the background work is actually done.

### Optional: Pre-configure Chat ID

Add your chat ID to `~/.config/opencode/telegram-remote/.env` to skip the first-message discovery step:

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
| `TELEGRAM_IDLE_SETTLE_DELAY_MS` | No | Quiet period (ms) the root session must stay continuously idle before a completion notification is sent. Suppresses false completion pings when a harness (e.g. oh-my-opencode) re-triggers the session after background subagents, todo-continuation, or context compaction. Set to `0` to disable. Default `12000`. | `12000` |

### OpenCode Plugin Configuration

The correct schema uses `"plugin"` (singular) with string entries:

```json
{
  "plugin": ["@coinseeker/opencode-telegram-plugin@latest"]
}
```

For local development from a clone, a `file://` absolute path is also supported:

```json
{
  "plugin": [
    "file:///Users/<your-username>/path/to/opencode-telegram-plugin/plugin/dist/telegram-remote.js"
  ]
}
```

## Security

### Access Control

- Only whitelisted user IDs can interact with the bot
- The whitelist is comma-separated in `~/.config/opencode/telegram-remote/.env`
- Non-whitelisted users are silently ignored

### Best Practices

1. Use a **private** chat with the bot (not a group)
2. Keep the bot token secret and out of version control
3. Only add trusted users to the whitelist
4. Check env file permissions: `chmod 600 ~/.config/opencode/telegram-remote/.env`

## Troubleshooting

### Bot doesn't send notifications

- Verify the bot token is correct in `~/.config/opencode/telegram-remote/.env`
- Confirm your user ID is in `TELEGRAM_ALLOWED_USER_IDS`
- Make sure you've sent at least one message to the bot to establish the chat
- Check the plugin log file (see below)

### Duplicate notifications

- This shouldn't happen with the leader/pass-through model, but if it does, check whether a stale lock file exists at `${os.tmpdir()}/opencoder-telegram-<hash>.lock` and delete it

### Button says `Failed to send answer to opencode`

- Confirm OpenCode is loading the current `@coinseeker/opencode-telegram-plugin` package.
- Restart OpenCode after updating the package.
- Check the log file for `failed to send question reply`.

### Subagent completion messages still arrive

- Update the package and restart OpenCode.
- Check the log for `suppressing child session idle notification`.
- For background subagents, check for `deferring parent idle notification - child sessions still running` followed by `sending deferred parent idle notification`.

### Chat not connecting

- Make sure you're using a **private** chat (not a group)
- Send any message to the bot to trigger chat discovery
- If using `TELEGRAM_CHAT_ID` in the env file, verify the ID is correct

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

### Local Clone Development

```bash
git clone https://github.com/coin-seeker/opencode-telegram-plugin.git
cd opencode-telegram-plugin
npm install
cd plugin
npm install
npm run build
```

For local testing, add the built file to `~/.config/opencode/opencode.json` with a `file://` absolute path. Restart OpenCode after rebuilding. The `file://` path stays the same as long as the clone location does not change.

### Project Structure

```
opencode-telegram-plugin/
├── .env                              # Optional dev credentials (repo root, gitignored)
├── .env.example                      # Template for .env
├── plugin/
│   ├── src/
│   │   ├── telegram-remote.ts        # Plugin entry point, event routing
│   │   ├── bot.ts                    # Grammy bot setup and manager
│   │   ├── config.ts                 # Config loading (via env-loader)
│   │   ├── events/
│   │   │   ├── session-idle.ts       # Handles idle/status completion notifications
│   │   │   ├── question-asked.ts     # Sends Telegram question prompts and replies
│   │   │   ├── question-replied.ts   # Cleans up answered question prompts
│   │   │   ├── session-created.ts    # Tracks session parent/title info
│   │   │   ├── session-updated.ts    # Tracks session parent/title info
│   │   │   ├── permission-updated.ts # Handles permission.updated → notification
│   │   │   ├── types.ts              # Shared TypeScript types
│   │   │   └── index.ts              # Re-exports all handlers
│   │   ├── lib/
│   │   │   ├── lock.ts               # File-lock leader election
│   │   │   ├── claim.ts              # Per-event cross-process dedup
│   │   │   ├── pending-questions.ts  # Persisted Telegram question state
│   │   │   ├── abort-tracker.ts      # Interrupt notification suppression
│   │   │   ├── state-store.ts        # Atomic JSON state persistence
│   │   │   ├── logger.ts             # Buffered file logger
│   │   │   └── env-loader.ts         # Multi-source .env loader
│   │   └── services/
│   │       └── session-title-service.ts  # Session title/parent/status cache
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
npm test           # Unit tests
```

### Testing Locally

1. Build the plugin: `npm run build`
2. Make sure `.env` exists in the repo root, or `~/.config/opencode/telegram-remote/.env` exists, with valid credentials
3. Add the `file://` path to your `~/.config/opencode/opencode.json`
4. Start OpenCode and message the bot to establish the connection
5. Run an OpenCode task and wait for the idle notification

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run typecheck`, `npm test`, and `npm run build`
5. Submit a pull request

## License

MIT
