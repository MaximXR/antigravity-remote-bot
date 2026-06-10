import { InlineKeyboard } from 'grammy';
import { AutoAcceptService } from '../services/autoAcceptService';
import { t } from '../utils/i18n';

export const AUTOACCEPT_TOGGLE_MASTER = 'autoaccept_toggle_master';
export const AUTOACCEPT_TOGGLE_CAT_PREFIX = 'autoaccept_toggle_cat:';
export const AUTOACCEPT_ALL_ON = 'autoaccept_all_on';
export const AUTOACCEPT_ALL_OFF = 'autoaccept_all_off';
export const AUTOACCEPT_BTN_REFRESH = 'autoaccept_btn_refresh';

export async function sendAutoAcceptUI(
    sendFn: (text: string, keyboard: InlineKeyboard) => Promise<void>,
    autoAcceptService: AutoAcceptService,
): Promise<void> {
    const s = autoAcceptService.getSettings();

    const masterStatus = s.enabled ? '🟢 ON' : '⚪ OFF';
    const fileEditsStatus = s.fileEdits ? '🟢 ON' : '⚪ OFF';
    const consoleCommandsStatus = s.consoleCommands ? '🟢 ON' : '⚪ OFF';
    const readAccessStatus = s.readAccess ? '🟢 ON' : '⚪ OFF';
    const urlAccessStatus = s.urlAccess ? '🟢 ON' : '⚪ OFF';
    const otherRequestsStatus = s.otherRequests ? '🟢 ON' : '⚪ OFF';

    const text =
        `<b>⚙️ ${t('Auto-accept Settings')}</b>\n\n` +
        `<b>${t('Master Switch')}:</b> ${masterStatus}\n\n` +
        `<b>${t('Categories')}:</b>\n` +
        `📂 ${t('file_edits')}: ${fileEditsStatus}\n` +
        `💻 ${t('console_commands')}: ${consoleCommandsStatus}\n` +
        `📖 ${t('read_access')}: ${readAccessStatus}\n` +
        `🌐 ${t('url_access')}: ${urlAccessStatus}\n` +
        `⚙️ ${t('other_requests')}: ${otherRequestsStatus}`;

    const keyboard = new InlineKeyboard()
        .text(s.enabled ? `🔴 ${t('Disable Master')}` : `🟢 ${t('Enable Master')}`, AUTOACCEPT_TOGGLE_MASTER)
        .row()
        .text(s.fileEdits ? `📂 ${t('File Edits')}: ✅` : `📂 ${t('File Edits')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}fileEdits`)
        .text(s.consoleCommands ? `💻 ${t('Console')}: ✅` : `💻 ${t('Console')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}consoleCommands`)
        .row()
        .text(s.readAccess ? `📖 ${t('Read')}: ✅` : `📖 ${t('Read')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}readAccess`)
        .text(s.urlAccess ? `🌐 ${t('URL')}: ✅` : `🌐 ${t('URL')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}urlAccess`)
        .row()
        .text(s.otherRequests ? `⚙️ ${t('Other')}: ✅` : `⚙️ ${t('Other')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}otherRequests`)
        .row()
        .text(`🟢 ${t('Enable All')}`, AUTOACCEPT_ALL_ON)
        .text(`⚪ ${t('Disable All')}`, AUTOACCEPT_ALL_OFF)
        .row()
        .text(`🔄 ${t('Refresh')}`, AUTOACCEPT_BTN_REFRESH);

    await sendFn(text, keyboard);
}
