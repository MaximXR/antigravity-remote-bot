import { InlineKeyboard } from 'grammy';
import { t } from '../utils/i18n';
import { SessionListItem } from '../services/chatSessionService';
import { escapeHtml } from '../utils/telegramFormatter';

export const SESSION_SELECT_ID = 'session_select';

const MAX_SELECT_OPTIONS = 25;

export function isSessionSelectId(customId: string): boolean {
    return customId.startsWith(SESSION_SELECT_ID + ':') || customId === SESSION_SELECT_ID;
}

// Cache of buttonId -> fullSessionTitle
export const sessionTitleCache = new Map<string, string>();

export function buildSessionPickerUI(
    sessions: SessionListItem[],
): { text: string; keyboard: InlineKeyboard } {
    if (sessions.length === 0) {
        return {
            text: `<b>🔗 Join Session</b>\n\n${t('No sessions found in the Antigravity side panel.')}`,
            keyboard: new InlineKeyboard(),
        };
    }

    const text = `<b>🔗 Join Session</b>\n\n` +
        t(`Select a session to join (${sessions.length} found)`);

    const keyboard = new InlineKeyboard();
    const pageItems = sessions.slice(0, MAX_SELECT_OPTIONS);

    for (const session of pageItems) {
        const label = session.isActive
            ? `✅ ${session.title.slice(0, 40)}`
            : session.title.slice(0, 40);
            
        // Generate a short unique key for the title
        const buttonId = Math.random().toString(36).substring(2, 9);
        sessionTitleCache.set(buttonId, session.title);
        
        keyboard.text(label, `${SESSION_SELECT_ID}:${buttonId}`).row();
    }

    return { text, keyboard };
}
