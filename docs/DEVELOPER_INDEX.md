# Remoat Developer and AI Agent Index

Concept map and code reference guide for the Remoat codebase. Designed for developers and AI models to locate features, understand control flows, and replicate core functionalities.

---

## 1. Codebase Structure at a Glance

| Subsystem / Layer | Core Files / Paths | Description |
|:---|:---|:---|
| **Entry Point & Router** | [src/bot/index.ts](file:///e:/Desktop/Remoat/src/bot/index.ts) | Grammy Telegram bot initialization, message routing, callback handling, task serialization queues. |
| **Command Parsers** | [src/commands/messageParser.ts](file:///e:/Desktop/Remoat/src/commands/messageParser.ts) | Identifies text-based commands and arguments. |
| | [src/commands/slashCommandHandler.ts](file:///e:/Desktop/Remoat/src/commands/slashCommandHandler.ts) | Routes templates and slash command parameters. |
| **Database & Repositories**| [src/database/](file:///e:/Desktop/Remoat/src/database/) | SQLite persistence using `better-sqlite3`. Tables: `chat_sessions`, `workspace_bindings`, `templates`, `schedules`. |
| **CDP Connection** | [src/services/cdpService.ts](file:///e:/Desktop/Remoat/src/services/cdpService.ts) | Connects to Electron/React via WebSockets. Context parsing, message injection, sidebar control. |
| | [src/services/cdpConnectionPool.ts](file:///e:/Desktop/Remoat/src/services/cdpConnectionPool.ts) | Manages multiple parallel workspace connections. |
| | [src/services/cdpBridgeManager.ts](file:///e:/Desktop/Remoat/src/services/cdpBridgeManager.ts) | Pairs active workspaces with Telegram channels and hooks up detectors. |
| **DOM Response Poller** | [src/services/responseMonitor.ts](file:///e:/Desktop/Remoat/src/services/responseMonitor.ts) | Polling loop (2s) extracting markdown text, thinking segments, and process logs. |
| **GUI Action Detectors** | [src/services/cdpBridgeManager.ts](file:///e:/Desktop/Remoat/src/services/cdpBridgeManager.ts) | Spawns background detectors for approval dialogs, errors, planning mode, and echo messages. |

---

## 2. Command Flow Map

When a Telegram command is triggered, it delegates actions as follows:

| Command | TG Command Entry | Core Service / Handler | Core GUI / DB Action |
|:---|:---|:---|:---|
| `/chats` | `src/bot/index.ts` (L2638) | `ChatSessionService.listAllSessions()` | Opens "Past Conversations" sidebar -> Scrapes row elements -> Simulates Escape. |
| `/new` | `src/bot/index.ts` (L2576) | `ChatSessionService.startNewChat()` | Clicks "New Chat" button -> Resets active session record in DB. |
| `/history` | `src/bot/index.ts` (L2670) | `ChatSessionService.getChatHistory()` | Reads response markdown list from DOM. |
| `/undo` | `src/bot/index.ts` (L2723) | `ChatSessionService.rollbackLastChanges()` | Focuses page -> Clicks Cascade "Undo" button -> Presses Enter. |
| `/workspace` | `src/bot/index.ts` (L2570) | `WorkspaceService` & `scanActiveWindows()` | Probes active IDE windows -> Displays select list. |
| `/status` | `src/bot/index.ts` (L2385) | `scanActiveWindows()` & `getCurrentSessionInfo()` | Returns LLM model, active workspace name, and active chat titles. |

---

## 3. Database Schema Mapping

State is stored in a local SQLite file (`antigravity.db`). DB queries are encapsulated in:

- **`workspace_bindings`** (`src/database/workspaceBindingRepository.ts`):
  - Binds Telegram Chat ID (`channel_id`) to the absolute filesystem path of the workspace (`workspace_path`).
- **`chat_sessions`** (`src/database/chatSessionRepository.ts`):
  - Stores currently active session number, display name (scraped title), and renamed flag for each bound Telegram topic channel.
- **`templates`** (`src/database/templateRepository.ts`):
  - Stores reusable prompt templates.

---

## 4. Documentation Directory (Index)

Refer to specific documentation guides when editing or replicating features:

- [CLAUDE.md](file:///e:/Desktop/Remoat/CLAUDE.md) — Quick command sheet, directory structure overview, and environment configurations.
- [docs/CHAT_SESSIONS_GUIDE.md](file:///e:/Desktop/Remoat/docs/CHAT_SESSIONS_GUIDE.md) — Detailed instructions on starting chats, scraping lists, and resolving Monaco QuickInput popups via CDP.
- [docs/ANTIGRAVITY_DOM_SELECTORS.md](file:///e:/Desktop/Remoat/docs/ANTIGRAVITY_DOM_SELECTORS.md) — Catalog of CSS selectors mapping UI components (input fields, message bubbles, dialog buttons).
- [docs/RESPONSE_MONITOR.md](file:///e:/Desktop/Remoat/docs/RESPONSE_MONITOR.md) — Inner workings of the 2-second polling loop, baseline suppression, and completion confirmation logic.
- [docs/dom-inspection-guide.md](file:///e:/Desktop/Remoat/docs/dom-inspection-guide.md) — Manual workflow for connecting Chrome DevTools to check selector changes after IDE updates.
