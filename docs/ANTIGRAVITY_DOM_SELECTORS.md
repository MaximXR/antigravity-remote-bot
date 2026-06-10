# Antigravity DOM Selectors Codebase Map

A reference catalog of all CSS selectors and browser script templates used by Remoat to operate the Antigravity IDE (Windsurf/Cascade panel).

---

## 1. Codebase Declarations

This index maps each DOM selector to the exact file where it is declared in the Remoat codebase:

| UI Component | Selector / Expression | Codebase Declaration File |
|:---|:---|:---|
| **Chat Side-Panel Root** | `.antigravity-agent-side-panel` | [src/services/cdpService.ts](file:///e:/Desktop/Remoat/src/services/cdpService.ts) (L50)<br/>[src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L40) |
| **New Chat Button** | `[data-tooltip-id="new-conversation-tooltip"]` | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L22) |
| **Active Chat Title** | `div[class*="border-b"]` and `div[class*="text-ellipsis"]` inside side-panel root | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L42-L44) |
| **Past Conversations Toggle** | `[data-past-conversations-toggle]`, `[data-tooltip-id]` containing `history` / `past-conversations`, or `svg.lucide-history` | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L66-L80) |
| **Past Conversations Container** | `div[class*="overflow-auto"]`, `div[class*="overflow-y-scroll"]`, or `#fastpick-listbox` | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L104-L108) |
| **Other Conversations Header** | `div[class*="text-xs"][class*="opacity"]` matching `/^Other\s+Conversations?$/i` | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L113-L117) |
| **Conversation Session Rows** | `div[class*="cursor-pointer"]` | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L124) |
| **Conversation Row Title** | `span.text-sm span, span.text-sm` (skipping timestamp patterns) | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L130) |
| **Active Row Class** | `/focusBackground/i` (regex test on className) | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L145) |
| **Show More Button** | `div, span` matching `/^Show\s+\d+\s+more/i` | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L157-L161) |
| **QuickInput Widget** | `.quick-input-widget, [class*="quick-input-widget"]` | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L811) |
| **QuickInput Filter Input** | `.quick-input-filter input` | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L815) |
| **QuickInput Rows / Options** | `.monaco-list-row, [role="option"], [role="button"]` | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L826) |
| **AI Response Text** | `.rendered-markdown` (Score 10)<br/>`.leading-relaxed.select-text` (Score 9)<br/>`.flex.flex-col.gap-y-3` (Score 8) | [src/services/responseMonitor.ts](file:///e:/Desktop/Remoat/src/services/responseMonitor.ts) (L14-L24) |
| **User Message Bubble** | `[class*="bg-gray-500/15"][class*="select-text"] .whitespace-pre-wrap` (A)<br/>`[class*="bg-gray-500/15"][class*="rounded-lg"][class*="select-text"]` (B) | [src/services/cdpBridgeManager.ts](file:///e:/Desktop/Remoat/src/services/cdpBridgeManager.ts) (L42)<br/>[src/detectors/userMessageDetector.ts](file:///e:/Desktop/Remoat/src/detectors/userMessageDetector.ts) |
| **Stop Button** | `[data-tooltip-id="input-send-button-cancel-tooltip"]` | [src/services/responseMonitor.ts](file:///e:/Desktop/Remoat/src/services/responseMonitor.ts) (L34) |
| **Undo / Rollback Button** | `button[data-testid="revert-button"], [role="button"][data-testid="revert-button"]` | [src/services/chatSessionService.ts](file:///e:/Desktop/Remoat/src/services/chatSessionService.ts) (L1031) |
| **Approval Modal Container** | `[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog` | [src/services/cdpBridgeManager.ts](file:///e:/Desktop/Remoat/src/services/cdpBridgeManager.ts) (L39)<br/>[src/detectors/approvalDetector.ts](file:///e:/Desktop/Remoat/src/detectors/approvalDetector.ts) |
| **Planning Notification** | `.notify-user-container` | [src/services/cdpBridgeManager.ts](file:///e:/Desktop/Remoat/src/services/cdpBridgeManager.ts) (L41)<br/>[src/detectors/planningDetector.ts](file:///e:/Desktop/Remoat/src/detectors/planningDetector.ts) |
| **Planning Modal Content** | `div.relative.pl-4.pr-4.py-1, div.relative.pl-4.pr-4` | [src/detectors/planningDetector.ts](file:///e:/Desktop/Remoat/src/detectors/planningDetector.ts) |
| **Error Popup Dialog** | `[role="dialog"], [role="alertdialog"], .modal, .dialog` | [src/services/cdpBridgeManager.ts](file:///e:/Desktop/Remoat/src/services/cdpBridgeManager.ts) (L40)<br/>[src/detectors/errorPopupDetector.ts](file:///e:/Desktop/Remoat/src/detectors/errorPopupDetector.ts) |

---

## 2. Key Action Scraped Selector Logic

### User Message Bubble Selection (`userMessageDetector.ts`)
Queries the User Message container inside the sidebar:
- Selector: `[class*="bg-gray-500/15"][class*="rounded-lg"][class*="select-text"]`
- Logic: When a new user bubble appears, the detector extracts the inner message text and triggers a sync callback to Telegram to mirror the user's prompt in the Telegram channel.

### Stop Button Checking (`responseMonitor.ts`)
ResponseMonitor checks the stop button status on every poll cycle (2s) to identify active generation:
- Selector: `[data-tooltip-id="input-send-button-cancel-tooltip"]`
- Fallback: scans all buttons (`button, [role="button"]`) containing words matching `stop`, `stop generating`, `stop response`, `停止`, `生成を停止`, `応答を停止`.

### Undo Button Click Logic (`chatSessionService.ts`)
To rollback changes:
1. Locates `button[data-testid="revert-button"]` center coordinates.
2. Clicks the coordinates via `Input.dispatchMouseEvent`.
3. Dispatches `Enter` keystroke via `Input.dispatchKeyEvent` to confirm the prompt dialog.

### Code Block Parsing (`assistantDomExtractor.ts`)
Normalizes raw response code blocks:
- Scopes to `pre` blocks.
- Identifies the language label using `.font-sans.text-sm` or `[class*="text-sm"][class*="opacity"]`.
- Locates line blocks using `.code-line, [class*="code-line"]`.
- Ignores injected `<style>` blocks and header bars matching `[class*="rounded-t"][class*="border-b"]`.
