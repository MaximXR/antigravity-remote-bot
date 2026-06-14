import { InlineKeyboard } from 'grammy';
import { AutoAcceptService } from '../services/autoAcceptService';
import { t } from '../utils/i18n';

export const AUTOACCEPT_TOGGLE_MASTER = 'autoaccept_toggle_master';
export const AUTOACCEPT_TOGGLE_CAT_PREFIX = 'autoaccept_toggle_cat:';
export const AUTOACCEPT_ALL_ON = 'autoaccept_all_on';
export const AUTOACCEPT_ALL_OFF = 'autoaccept_all_off';
export const AUTOACCEPT_BTN_REFRESH = 'autoaccept_btn_refresh';

export const AUTOACCEPT_TOGGLE_STRATEGY = 'autoaccept_toggle_strategy';
export const AUTOACCEPT_TOGGLE_NOTIFICATIONS = 'autoaccept_toggle_notifications';
export const AUTOACCEPT_CYCLE_FILTER = 'autoaccept_cycle_filter';

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
    const browserAccessStatus = s.browserAccess ? '🟢 ON' : '⚪ OFF';
    const otherRequestsStatus = s.otherRequests ? '🟢 ON' : '⚪ OFF';

    const autoApproveAlwaysStatus = s.autoApproveAlways ? t('Always') : t('Only once');
    const notifyOnAutoApproveStatus = s.notifyOnAutoApprove ? '🟢 ON' : '⚪ OFF';
    const approvalMirrorModeStatus = t(`approval_filter_${s.approvalMirrorMode}`);

    const text =
        `<b>⚙️ ${t('Auto-accept Settings')}</b>\n\n` +
        `<b>${t('Master Switch')}:</b> ${masterStatus}\n\n` +
        `<b>${t('Categories')}:</b>\n` +
        `📂 ${t('file_edits')}: ${fileEditsStatus}\n` +
        `💻 ${t('console_commands')}: ${consoleCommandsStatus}\n` +
        `📖 ${t('read_access')}: ${readAccessStatus}\n` +
        `🌐 ${t('url_access')}: ${urlAccessStatus}\n` +
        `🧭 ${t('browser_access')}: ${browserAccessStatus}\n` +
        `⚙️ ${t('other_requests')}: ${otherRequestsStatus}\n\n` +
        `<b>${t('Settings')}:</b>\n` +
        `⚙️ ${t('Auto-approve strategy')}: <b>${autoApproveAlwaysStatus}</b>\n` +
        `🔔 ${t('Auto-approve notifications')}: <b>${notifyOnAutoApproveStatus}</b>\n` +
        `📣 ${t('Manual approval filter')}: <b>${approvalMirrorModeStatus}</b>\n\n` +
        `<b>${t('autoaccept_help_title')}</b>\n` +
        `${t('autoaccept_help_strategy')}\n` +
        `${t('autoaccept_help_notify')}\n` +
        `${t('autoaccept_help_filter')}`;

    const keyboard = new InlineKeyboard()
        .text(s.enabled ? `🟢 ${t('Disable Master')}` : `🔴 ${t('Enable Master')}`, AUTOACCEPT_TOGGLE_MASTER)
        .row()
        .text(s.readAccess ? `📖 ${t('Read')}: ✅` : `📖 ${t('Read')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}readAccess`)
        .text(s.fileEdits ? `📂 ${t('File Edits')}: ✅` : `📂 ${t('File Edits')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}fileEdits`)
        .row()
        .text(s.urlAccess ? `🌐 ${t('URL')}: ✅` : `🌐 ${t('URL')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}urlAccess`)
        .text(s.browserAccess ? `🧭 ${t('Browser')}: ✅` : `🧭 ${t('Browser')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}browserAccess`)
        .row()
        .text(s.consoleCommands ? `💻 ${t('Console')}: ✅` : `💻 ${t('Console')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}consoleCommands`)
        .text(s.otherRequests ? `⚙️ ${t('Other')}: ✅` : `⚙️ ${t('Other')}: ❌`, `${AUTOACCEPT_TOGGLE_CAT_PREFIX}otherRequests`)
        .row()
        .text(`🟢 ${t('Enable All')}`, AUTOACCEPT_ALL_ON)
        .text(`⚪ ${t('Disable All')}`, AUTOACCEPT_ALL_OFF)
        .row()
        .text(`🔔 ${t('Auto-approve notifications')}: ${s.notifyOnAutoApprove ? '✅' : '❌'}`, AUTOACCEPT_TOGGLE_NOTIFICATIONS)
        .row()
        .text(`📣 ${t('Manual approval filter')}: ${approvalMirrorModeStatus}`, AUTOACCEPT_CYCLE_FILTER)
        .row()
        .text(`⚙️ ${t('Auto-approve strategy')}: ${autoApproveAlwaysStatus}`, AUTOACCEPT_TOGGLE_STRATEGY)
        .row()
        .text(`🔄 ${t('Refresh')}`, AUTOACCEPT_BTN_REFRESH);

    await sendFn(text, keyboard);
}
