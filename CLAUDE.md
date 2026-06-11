# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Remoat

Remoat is a local Telegram bot (grammy) that remotely operates Antigravity (an AI coding assistant) via Chrome DevTools Protocol (CDP). No external server — runs entirely on the user's PC. Users control Antigravity from their smartphone through Telegram.

## Commands

```bash
npm test                # Run unit tests (jest, excludes e2e)
npm run test:unit       # Same as npm test
npm run test:integration # Run integration tests (e2e.bot.test.ts)
npm run test:watch      # Jest watch mode
npm run build           # TypeScript compilation (tsc)
npm run dev             # Dev mode with auto-reload (ts-node-dev)
npm start               # Run from source (ts-node)
npm start -- setup      # Run setup wizard from source
npm run start:built     # Run from compiled dist/
```

Run a single test file: `npx jest tests/path/to/file.test.ts`

Note: jest.config.js ignores `responseMonitor.test.ts` and `responseMonitor.stopButtonSelector.test.ts` by default (these are large, slow test files).

## Architecture

Three-layer design: **CLI → Bot Layer → IDE Core Layer → Services/DB**

- **`src/bin/`** — Commander CLI with subcommands: `start`, `setup`, `doctor`, `open`
- **`src/bot/`** — Telegram bot event handling, message routing, callback queries, and UI components markup (`src/ui/`).
- **`src/commands/`** — Slash command handlers (`/project`, `/new`, `/chat`, `/model`, `/mode`, `/template`, `/stop`, `/screenshot`, `/status`, `/autoaccept`, `/cleanup`, `/help`) and message parser.
- **`src/services/`** — Core business logic:
  - **IDE Prompt Runner**: `idePromptRunner.ts` — Decoupled runner managing prompt injections and response monitors.
  - **QuickPick Selector**: `quickPickResolver.ts` — Automates IDE window selection and resolution.
  - **CDP integration**: `cdpService.ts`, `cdpBridgeManager.ts`, `cdpConnectionPool.ts` — WebSocket communication with Antigravity.
  - **Response monitoring**: `responseMonitor.ts` — Scrapes responses, thinking blocks, and logs.
  - **Feature detectors**: `approvalDetector.ts`, `planningDetector.ts`, `errorPopupDetector.ts`, `userMessageDetector.ts`.
- **`src/database/`** — SQLite persistence repositories.
- **`src/ui/`** — Telegram InlineKeyboard builders.
- **`src/utils/`** — Config loading, logging, Telegram formatting, path security, i18n.

## Key Technical Details

- **TypeScript strict mode**, target ES2022, CommonJS modules.
- **Path alias**: `@/` maps to `src/` in tests only. Source code uses relative imports.
- **Config**: `.env` or local `.remoat/config.json`.
- **Database**: Local SQLite file (`.remoat/antigravity.db`) with schemas in [docs/DB_SCHEMA.md](file:///e:/Desktop/Remoat/docs/DB_SCHEMA.md).

## Code Conventions

- **Conventional Commits**: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`
- Prefer `interface` over `type` for object definitions.
- Prefer `const` over `let`; avoid direct object/array mutation (use spread).
- CDP Button clicks normalization: Target strings inside expressions MUST be lowercase (e.g. `'allow'`, `'deny'`) to match normalization inside `buildClickScript`.

## Diagnostics & Scripts

All diagnostic and CDP inspection scripts are located in the `diagnostics/` directory.
- `diagnostics/list_cdp_pages.js` - List active Chrome DevTools targets and ports.
- `diagnostics/capture_real_screenshot.js` - Capture and save a screenshot of the active Antigravity IDE workbench.
- `diagnostics/test_cdp_contexts.ts` - Check and log active CDP Execution Contexts.
- `diagnostics/click_undo.js` - Align and click the Cascade rollback button.
