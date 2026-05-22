# OpenCode Telegram Plugin

Control and monitor OpenCode from Telegram.

## Install

Configure the npm package in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@coinseeker/opencode-telegram-plugin"]
}
```

Restart OpenCode after editing the config. OpenCode resolves npm package plugins on startup.

## Configure Telegram

Create `~/.config/opencode/telegram-remote/.env`:

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

Keep this file private. Never commit or share your Telegram bot token.

## Usage

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather).
2. Get your numeric Telegram user ID from [@userinfobot](https://t.me/userinfobot).
3. Add the token and allowed user IDs to the env file above.
4. Restart OpenCode.
5. Send any message to your bot in a private Telegram chat.

## Features

- Root session completion notifications.
- Background subagent-aware completion: child session messages are suppressed and parent completion waits until children finish.
- OpenCode question prompts via Telegram inline buttons.
- Custom free-text answers from Telegram.
- Permission alerts.
- Multi-session-safe Telegram polling through a file-lock leader model.
- Log file output instead of stdout terminal spam.

## Logs

```bash
node -e "const os=require('os'); console.log(os.tmpdir() + '/opencoder-telegram.log')"
```

## Source

https://github.com/coin-seeker/opencode-telegram-plugin
