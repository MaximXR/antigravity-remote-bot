import { Context, Bot } from 'grammy';
import { CallbackDependencies } from '../callbacks';
import {
    SESSION_SELECT_ID,
    isSessionSelectId,
    sessionTitleCache,
    buildSessionPickerUI,
} from '../../ui/sessionPickerUi';
import { registerApprovalSessionChannel } from '../../services/cdpBridgeManager';
import { channelKeyFromChannel } from '../../services/workspaceResolver';
import { escapeHtml, splitTelegramHtml } from '../../utils/telegramFormatter';
import { htmlToTelegramHtml } from '../../utils/htmlToTelegramMarkdown';
import { t } from '../../utils/i18n';
import { logger } from '../../utils/logger';

const channelKey = channelKeyFromChannel;
const TELEGRAM_MSG_LIMIT = 4096;

export async function handleSessions(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const {
        bridge,
        chatSessionService,
        chatSessionRepo,
        workspaceBindingRepo,
        workspaceService,
    } = deps;

    // Session selection
    if (isSessionSelectId(data)) {
        const buttonId = data.replace(`${SESSION_SELECT_ID}:`, '');
        const selectedTitle = sessionTitleCache.get(buttonId) || buttonId;
        const key = channelKey(ch);
        const binding = workspaceBindingRepo.findByChannelId(key);
        if (!binding) {
            await ctx.answerCallbackQuery({ text: 'No project bound.' });
            return true;
        }
        const workspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
        try {
            const cdp = await bridge.pool.getOrConnect(workspacePath);
            const activateResult = await chatSessionService.activateSessionByTitle(cdp, selectedTitle);
            if (activateResult.ok) {
                let session = chatSessionRepo.findByChannelId(key);
                if (!session) {
                    const maxNum = chatSessionRepo.getNextSessionNumber(key);
                    chatSessionRepo.create({
                        channelId: key,
                        categoryId: key,
                        workspacePath: binding.workspacePath,
                        sessionNumber: maxNum,
                        guildId: String(ctx.chat!.id),
                    });
                    session = chatSessionRepo.findByChannelId(key);
                }
                if (session) {
                    chatSessionRepo.updateDisplayName(key, selectedTitle);
                }

                const projectName = bridge.pool.extractProjectName(workspacePath);
                if (projectName) {
                    registerApprovalSessionChannel(bridge, projectName, selectedTitle, ch);
                }

                await ctx.editMessageText(`<b>🔗 Joined Session</b>\n\n<b>${escapeHtml(selectedTitle)}</b>`, { parse_mode: 'HTML' });
            } else {
                await ctx.answerCallbackQuery({ text: `Failed: ${activateResult.error}` });
            }
        } catch (e: any) {
            await ctx.answerCallbackQuery({ text: `Error: ${e.message}` });
        }
        return true;
    }

    // Show dialogs in current active window
    if (data === 'current_dialogs') {
        const resolved = await deps.resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.answerCallbackQuery({ text: 'Not connected to workspace.' });
            return true;
        }

        await ctx.answerCallbackQuery({ text: 'Scanning sessions...' });
        const statusMsg = await ctx.reply('🔍 Scanning sessions in Antigravity...');
        try {
            const sessions = await chatSessionService.listAllSessions(resolved.cdp);
            const { text, keyboard } = buildSessionPickerUI(sessions);
            await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (e: any) {
            await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
            await ctx.reply(`❌ Failed to list sessions: ${e.message}`);
        }
        return true;
    }

    // Show history of active dialog in current active window
    if (data === 'current_history') {
        const resolved = await deps.resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.answerCallbackQuery({ text: 'Not connected to workspace.' });
            return true;
        }

        await ctx.answerCallbackQuery({ text: 'Retrieving history...' });
        const statusMsg = await ctx.reply('🔍 ' + t('Scanning sessions in Antigravity...'));
        try {
            const history = await chatSessionService.getChatHistory(resolved.cdp, 5);
            await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

            if (history.length === 0) {
                await ctx.reply(t('No messages found in history.'), { parse_mode: 'HTML' });
                return true;
            }

            const formattedTurns = history.map(turn => {
                if (turn.role === 'user') {
                    return `👤 <b>${t('You')}:</b>\n${escapeHtml(turn.text || '')}`;
                } else {
                    return `🤖 <b>${t('Assistant')}:</b>\n${htmlToTelegramHtml(turn.html || '')}`;
                }
            });

            const fullHtml = formattedTurns.join('\n\n---\n\n');
            const chunks = splitTelegramHtml(fullHtml, TELEGRAM_MSG_LIMIT);
            for (const chunk of chunks) {
                if (chunk.trim()) {
                    await ctx.reply(chunk, { parse_mode: 'HTML' });
                }
            }
        } catch (e: any) {
            await bot.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
            await ctx.reply(`❌ Failed to retrieve history: ${e.message}`);
        }
        return true;
    }

    return false;
}
