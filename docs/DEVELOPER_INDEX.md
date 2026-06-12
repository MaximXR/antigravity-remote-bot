# Remoat Developer and AI Agent Index

Concept map and code reference guide for the Remoat codebase. Designed for developers and AI models to locate features, understand control flows, and replicate core functionalities.

---

## 1. Codebase Structure at a Glance

| Subsystem / Layer | Core Files / Paths | Description |
|:---|:---|:---|
| **Entry Point & Router** | [src/bot/index.ts](file:///e:/Desktop/Remoat/src/bot/index.ts) | Grammy Telegram bot initialization, middleware registration, and entry routing. |
| | [src/bot/botState.ts](file:///e:/Desktop/Remoat/src/bot/botState.ts) | Global bot caches, collections, and maps to avoid circular dependencies. |
| | [src/bot/tgMirror.ts](file:///e:/Desktop/Remoat/src/bot/tgMirror.ts) | Decoupled logic for mirroring LLM progress, chunking HTML content, and delivering files/images to Telegram. |
| | [src/bot/commands.ts](file:///e:/Desktop/Remoat/src/bot/commands.ts) | Handlers and registration for Telegram slash commands. |
| | [src/bot/callbacks.ts](file:///e:/Desktop/Remoat/src/bot/callbacks.ts) | Thin entry router for inline keyboard callback queries. |
| | [src/bot/callbacks/](file:///e:/Desktop/Remoat/src/bot/callbacks/) | Modularized handlers for callback actions (sessions, plans, templates, settings, etc.). |
| | [src/bot/messageHandlers.ts](file:///e:/Desktop/Remoat/src/bot/messageHandlers.ts) | Thin entry router for text, photo, document, and voice messages. |
| | [src/bot/messages/](file:///e:/Desktop/Remoat/src/bot/messages/) | Modularized handlers for message types (text, media, voice). |
| | [src/bot/telegramAdapter.ts](file:///e:/Desktop/Remoat/src/bot/telegramAdapter.ts) | Telegram adapter implementation of IMessengerPort. |
| | [src/bot/telegramTopicManager.ts](file:///e:/Desktop/Remoat/src/bot/telegramTopicManager.ts) | Manages Telegram forum topics and naming. |
| **Command Parsers** | [src/commands/messageParser.ts](file:///e:/Desktop/Remoat/src/commands/messageParser.ts) | Identifies text-based commands and arguments. |
| | [src/commands/slashCommandHandler.ts](file:///e:/Desktop/Remoat/src/commands/slashCommandHandler.ts) | Routes templates and slash command parameters. |
| **Database & Repositories**| [src/database/](file:///e:/Desktop/Remoat/src/database/) | SQLite persistence using `better-sqlite3`. Tables and schema documented in [DB_SCHEMA.md](file:///e:/Desktop/Remoat/docs/DB_SCHEMA.md). |
| **CDP Connection** | [src/services/cdpService.ts](file:///e:/Desktop/Remoat/src/services/cdpService.ts) | Connects to Electron/React via WebSockets. Context parsing, message injection, sidebar control. |
| | [src/services/cdpConnectionPool.ts](file:///e:/Desktop/Remoat/src/services/cdpConnectionPool.ts) | Manages multiple parallel workspace connections. |
| | [src/services/cdpBridgeManager.ts](file:///e:/Desktop/Remoat/src/services/cdpBridgeManager.ts) | Pairs active workspaces with Telegram channels and hooks up detectors. |
| | [src/services/messengerPort.ts](file:///e:/Desktop/Remoat/src/services/messengerPort.ts) | Core abstraction interface (IMessengerPort) for decoupled delivery. |
| **IDE Interaction Runner**| [src/services/idePromptRunner.ts](file:///e:/Desktop/Remoat/src/services/idePromptRunner.ts) | Decoupled core layer runner to execute prompts and monitor responses via CDP, independent of Telegram. |
| **QuickPick Selector** | [src/services/quickPickResolver.ts](file:///e:/Desktop/Remoat/src/services/quickPickResolver.ts) | Dialog detection and resolution logic for active workspace QuickPick. |
| **DOM Response Poller** | [src/services/responseMonitor.ts](file:///e:/Desktop/Remoat/src/services/responseMonitor.ts) | Polling loop (2s) extracting markdown text, thinking segments, and process logs. |
| **GUI Action Detectors** | [src/services/questionDetector.ts](file:///e:/Desktop/Remoat/src/services/questionDetector.ts), [src/services/cdpBridgeManager.ts](file:///e:/Desktop/Remoat/src/services/cdpBridgeManager.ts) | Spawns background detectors for approval dialogs, errors, planning mode, interactive questions, and echo messages. |

---

## 2. Command Flow Map

When a Telegram command is triggered, it delegates actions as follows:

| Command | TG Command Entry | Core Service / Handler | Core GUI / DB Action |
|:---|:---|:---|:---|
| `/chats` | `src/bot/commands.ts` | `ChatSessionService.listAllSessions()` | Opens "Past Conversations" sidebar -> Scrapes row elements -> Simulates Escape. |
| `/new` | `src/bot/commands.ts` | `ChatSessionService.startNewChat()` | Clicks "New Chat" button -> Resets active session record in DB. |
| `/history` | `src/bot/commands.ts` | `ChatSessionService.getChatHistory()` | Reads response markdown list from DOM. |
| `/undo` | `src/bot/commands.ts` | `ChatSessionService.rollbackLastChanges()` | Focuses page -> Clicks Cascade "Undo" button -> Presses Enter. |
| `/workspace` | `src/bot/commands.ts` | `WorkspaceService` & `scanActiveWindows()` | Probes active IDE windows -> Displays select list. |
| `/status` | `src/bot/commands.ts` | `scanActiveWindows()` & `getCurrentSessionInfo()` | Returns LLM model, active workspace name, and active chat titles. |

---

## 3. Database Schema Mapping

State is stored in a local SQLite file (`antigravity.db`). For details, see [DB_SCHEMA.md](file:///e:/Desktop/Remoat/docs/DB_SCHEMA.md).

DB queries are encapsulated in:
- **`workspace_bindings`** (`src/database/workspaceBindingRepository.ts`):
  - Binds Telegram Chat ID (`channel_id`) to the absolute filesystem path of the workspace (`workspace_path`).
- **`chat_sessions`** (`src/database/chatSessionRepository.ts`):
  - Stores currently active session number, display name (scraped title), and renamed flag for each bound Telegram topic channel.
- **`templates`** (`src/database/templateRepository.ts`):
  - Stores reusable prompt templates.
- **`schedules`** (`src/database/scheduleRepository.ts`):
  - Stores cron expressions and prompts for background task executions.

---

## 4. Documentation Directory (Index)

Refer to specific documentation guides when editing or replicating features:

- [CLAUDE.md](file:///e:/Desktop/Remoat/CLAUDE.md) — Quick command sheet, directory structure overview, and environment configurations.
- [docs/ARCHITECTURE.md](file:///e:/Desktop/Remoat/docs/ARCHITECTURE.md) — Deep overview of the decoupled architecture layers and data flows.
- [docs/DB_SCHEMA.md](file:///e:/Desktop/Remoat/docs/DB_SCHEMA.md) — Reference for SQLite tables schemas and DB locations.
- [docs/CHAT_SESSIONS_GUIDE.md](file:///e:/Desktop/Remoat/docs/docs/CHAT_SESSIONS_GUIDE.md) — Detailed instructions on starting chats, scraping lists, and resolving Monaco QuickInput popups via CDP.
- [docs/ANTIGRAVITY_DOM_SELECTORS.md](file:///e:/Desktop/Remoat/docs/ANTIGRAVITY_DOM_SELECTORS.md) — Catalog of CSS selectors mapping UI components (input fields, message bubbles, dialog buttons).
- [docs/RESPONSE_MONITOR.md](file:///e:/Desktop/Remoat/docs/RESPONSE_MONITOR.md) — Inner workings of the 2-second polling loop, baseline suppression, and completion confirmation logic.
- [docs/dom-inspection-guide.md](file:///e:/Desktop/Remoat/docs/dom-inspection-guide.md) — Manual workflow for connecting Chrome DevTools to check selector changes after IDE updates.
