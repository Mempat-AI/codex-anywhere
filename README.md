# Codex Anywhere

Codex Anywhere is a Telegram-native client for `codex`, so you can use Codex anywhere, anytime with session continuity, native Codex commands, featured `/goal` support, and first-class Oh-My-Codex workflows. Install it as a background service to operate native Codex from Telegram at your fingertips anywhere, anytime, 24/7, with no extra API key.

<table width="100%">
  <tr>
    <td width="25%" align="center" valign="top">
      <img src="docs/images/telegram-resume.png" alt="Resume sessions" width="100%" style="border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.25);" /><br/>
      <b>Session continuity</b><br/>
      Browse and resume recent Codex sessions from your phone
    </td>
    <td width="25%" align="center" valign="top">
      <img src="docs/images/telegram-image-upload.PNG" alt="Image upload" width="100%" style="border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.25);" /><br/>
      <b>Image + text turns</b><br/>
      Send a screenshot with a caption — both land in one Codex turn
    </td>
    <td width="25%" align="center" valign="top">
      <img src="docs/images/telegram-omx-support.png" alt="OMX support" width="100%" style="border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.25);" /><br/>
      <b>OMX integration</b><br/>
      Run featured <a href="https://github.com/Yeachan-Heo/oh-my-codex">Oh-My-Codex</a> workflows and commands directly from Telegram
    </td>
    <td width="25%" align="center" valign="top">
      <img src="docs/images/telegram-new-esc.png" alt="New session and interrupt" width="100%" style="border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.25);" /><br/>
      <b>Turn control</b><br/>
      Start new sessions, set goals, steer active turns, queue or interrupt on the fly
    </td>
  </tr>
</table>

## Prerequisites

- **[codex](https://github.com/openai/codex)** installed and signed in
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Quick Start

### 1. Install

```bash
npm install -g codex-anywhere
```

Check the installed CLI version with:

```bash
codex-anywhere --version
```

### 2. Create a Telegram bot

Open [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, and follow the prompts.
Copy the bot token for the next step.

### 3. Connect

```bash
codex-anywhere connect
```

```
Telegram bot token (from BotFather): <paste your token here>
Workspace path for Codex tasks [/current/dir]:  ← press Enter to accept
```

The workspace defaults to the folder where you run `connect`.

### Add another Telegram bot

```bash
codex-anywhere add-bot
```

Use this when you want another bot pointed at another workspace.

### 4. Install the background service

```bash
codex-anywhere install-service
```

This registers a LaunchAgent (macOS) so the bot starts at login and keeps running when the terminal closes.
On Linux, it installs a user-level `systemd` service.

### 5. Open Telegram and send `/start`

Your bot is ready. Try `/help` to see available commands, or just send a task to begin.

## Usage

Send a task to start a new Codex session, or use these commands:

- `/new` starts fresh
- `/resume` continues a session from the current workspace
- `/continue` browses sessions from all workspaces
- `/reload` refreshes the current session
- `/goal` shows or changes the current goal
- `/account` shows, signs in, switches, or signs out of Codex
- `/upgrade` updates Codex Anywhere and relaunches the service
- `/esc` stops the active turn

You can also send screenshots, photos, and files. Text files such as `.txt`, `.log`, `.json`, and `.crash` are sent as readable text so Codex can inspect them directly.

For Oh-My-Codex, send `$deep-interview`, `$autopilot`, or other skills directly in chat. Use `/omx <args>` for OMX commands.

For Computer Use, send `/computer <task>`. Enable Computer Use in the Codex app first.

## Service Management

```bash
codex-anywhere restart-service
codex-anywhere service-status
codex-anywhere uninstall-service
```

Logs are written to `logs/` under the Codex Anywhere storage root (`CODEX_ANYWHERE_HOME`).

## Telegram Commands

| Command | Description |
|---|---|
| `/workspace <path>` | Show or change the bot workspace |
| `/addbot` | Add another Telegram bot |
| `/resume` | Continue a session in this workspace |
| `/continue [session-id]` | Continue from any workspace |
| `/reload` | Refresh the current session |
| `/account [status\|login\|switch\|logout]` | Manage Codex sign-in |
| `/goal [status\|set <objective>\|clear]` | Manage the current goal |
| `/upgrade` | Upgrade Codex Anywhere |
| `/omx [args]` | Run Oh-My-Codex commands |
| `/computer <task>` | Use Computer Use |
| `/esc` | Interrupt the active turn |

Many native Codex slash commands also work from Telegram, including `/model`, `/permissions`, `/sandbox`, `/review`, `/compact`, `/diff`, `/mention`, `/mcp`, `/apps`, and `/logout`.

## Development

Clone and install:

```bash
git clone https://github.com/Mempat-AI/codex-anywhere
cd codex-anywhere
pnpm install
pnpm run connect   # runs directly from src/ via tsx
pnpm run add-bot   # appends a new bot definition to config
```

Run checks:

```bash
pnpm run test
pnpm run typecheck
pnpm run build
```

Tests are local and do not require Telegram, Codex, OMX, or network access.

## Contributing

Use pull requests for all changes.

Repository policy:
- PR title gate
- CI gate
- squash merge only

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution rules.

## Notes

- Single-user (for now), private chats only
- `codex` must be installed and authenticated before setup
- Config and state live under the user config directory or `CODEX_ANYWHERE_HOME`
- Background services support macOS LaunchAgent and Linux user-level `systemd`

---

Not affiliated with OpenAI.

Built with 💡 in Singapore.
