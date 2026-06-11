<h1 align="center" style="margin-top:0">Remoat</h1>

<p align="center">
  <strong>Control your AI coding assistant from anywhere — right from Telegram.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/MaximXR/Antigravity-Remote-Bot?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=flat-square" alt="Platform" />
</p>

---

Remoat is a **fully portable, local Telegram bot** that allows you to remotely operate your [Antigravity](https://antigravity.dev) IDE from your phone, tablet, or any device running Telegram.

Just send a text instruction, attach a screenshot, or record a voice note. Remoat dispatches it to Antigravity via the Chrome DevTools Protocol (CDP), monitors progress in real time, and streams results back to your Telegram chat.

## Key Architecture & Portability Features

- **Ports & Adapters Architecture**: The codebase is strictly split into a **Core Layer** (responsible for IDE communication, DOM monitoring, session state, and templates) and **Messenger Adapters** (currently `TelegramAdapter`). This ensures the core logic is 100% decoupled from any specific messenger framework.
- **100% Portable Configuration**: All mutable state, including SQLite databases (`antigravity.db`), launch lockfiles (`.bot.lock`), and update caches (`updater.json`), is kept locally inside the `.remoat/` folder in the project root. No files are written to the user's home directory.
- **Isolated Logging**: Run logs (like `bot_run.log`) and telemetry are redirected to a dedicated `/temp` directory, which is ignored by Git to keep your working copy clean.
- **Local Voice Transcription**: Voice notes are transcribed locally using `whisper.cpp` (requires downloading the local Whisper model). No external cloud service receives your audio.

## Table of Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Commands](#commands)
- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [License](#license)

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or higher.
- [Antigravity IDE](https://antigravity.dev) installed on your machine.
- A [Telegram](https://telegram.org/) account.

### 1. Clone and Install

```bash
git clone https://github.com/MaximXR/Antigravity-Remote-Bot.git
cd Antigravity-Remote-Bot
npm install
```

### 2. Configuration Wizard

Initialize the application configuration:

```bash
npm start -- setup
```

The wizard will guide you through:
- **Telegram Bot Token** — Obtain a token from [@BotFather](https://t.me/BotFather) (`/newbot`).
- **Allowed User IDs** — Whitelisted Telegram user IDs authorized to access the bot (get yours via [@userinfobot](https://t.me/userinfobot)).
- **Workspace Directory** — The local folder where your coding projects are stored (e.g. `E:\Projects` or `~/Projects`).

### 3. Open Antigravity with CDP Port

```bash
# Automated launch script
npm start -- open
```

*Note: Alternatively, you can use the launch scripts in the root directory like `start_antigravity_win.bat` or `start_antigravity_mac.command`.*

### 4. Start the Bot

```bash
npm start
```
Or for development with auto-reload:
```bash
npm run dev
```

---

## Features

- **Topic-Based Workspace Mapping**: Maps different directories/projects to specific Telegram group threads (Forum Topics). Chat sessions are persistent and isolated within these topics.
- **Real-Time Progress Streaming**: Long-running tasks stream their execution phase, elapsed time, and logs directly as updating Telegram messages.
- **Action Approval Routing**: Confirmation screens (file edits, terminal execution) are forwarded to Telegram as interactive inline keyboard selectors (Approve/Reject).
- **Auto-Approval System**: Custom configurations allow auto-approving read access, file writes, or CLI commands individually.
- **Security Whitelisting**: Only authorized user IDs can communicate with the bot; unauthorized attempts are ignored.

---

## Commands

### Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/project` | Browse and select a project (inline keyboard) |
| `/new` | Start a new chat session in the current project |
| `/chat` | Show current session info and list all sessions |
| `/model [name]` | Switch the LLM model (e.g., `gemini-2.5-pro`, `claude-3-5-sonnet`) |
| `/mode` | Switch execution mode (`fast` or `plan`) |
| `/stop` | Force-stop a running Antigravity task |
| `/template` | List registered prompt templates |
| `/template_add <name> <prompt>` | Register a new prompt template |
| `/template_delete <name>` | Delete a template |
| `/screenshot` | Capture and send Antigravity's current screen |
| `/status` | Show connection status, active project, and current mode |
| `/autoaccept` | Toggle auto-approval configurations |
| `/cleanup [days]` | Clean up inactive session topics |
| `/help` | Show available commands |

---

## How It Works

1. **Telegram Message**: A user sends an instruction or media to the bot.
2. **Context Resolution**: The bot maps the active forum topic (or group thread) to a workspace path and locates an open Antigravity window with the matching project.
3. **CDP Injection**: The prompt is injected directly into the IDE's UI/DOM via WebSocket debugging interface.
4. **DOM Monitoring**: `ResponseMonitor` polls the IDE at 2-second intervals to detect planning stages, user approvals, execution logs, and final completion.
5. **Real-time Streaming**: Statuses are formatted and sent back as dynamic, updating Telegram messages.

Detailed diagrams and specifications are available in the [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) file.

---

## Project Structure

```
.remoat/        <-- Local configuration and SQLite databases (git-ignored)
temp/           <-- Runtime logs (git-ignored)
docs/           <-- Design specs, schemas, and references
src/
  bin/          <-- CLI commands and configuration wizard
  bot/          <-- Telegram adapter and bot interface logic
  commands/     <-- Command parsers and slash handlers
  database/     <-- SQLite database repositories
  services/     <-- Core business logic (CDP, ResponseMonitor, detectors)
  ui/           <-- Telegram keyboard and message builders
  utils/        <-- Portable lockfile, logger, config loaders, and helper scripts
tests/          <-- Unit and integration test suites
```

---

## License

[MIT](LICENSE)

Based on the original [Remoat](https://github.com/optimistengineer/remoat) project and [LazyGravity](https://github.com/tokyoweb3/LazyGravity).
