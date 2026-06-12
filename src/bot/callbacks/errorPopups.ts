import { Context, Bot } from 'grammy';
import { CallbackDependencies } from '../callbacks';
import { parseErrorPopupCustomId } from '../../services/cdpBridgeManager';
import { escapeHtml } from '../../utils/telegramFormatter';
import { logger } from '../../utils/logger';

export async function handleErrorPopups(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const errorAction = parseErrorPopupCustomId(data);
    if (!errorAction) return false;

    const { bridge } = deps;
    const projectName = errorAction.projectName ?? bridge.lastActiveWorkspace;
    let detector = projectName ? bridge.pool.getErrorPopupDetector(projectName) : undefined;
    if (!detector) {
        const resolved = await deps.resolveWorkspaceAndCdp(ch);
        if (resolved.ok) {
            detector = bridge.pool.getErrorPopupDetector(resolved.projectName);
        }
    }
    if (!detector) {
        await ctx.answerCallbackQuery({ text: 'Error popup detector not found.' });
        return true;
    }

    if (errorAction.action === 'dismiss') {
        const clicked = await detector.clickDismissButton();
        if (clicked) {
            try {
                await ctx.editMessageReplyMarkup({ reply_markup: undefined });
            } catch (e) {
                logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
            }
        }
        await ctx.answerCallbackQuery({ text: clicked ? 'Dismissed' : 'Button not found.' });
    } else if (errorAction.action === 'copy_debug') {
        const clicked = await detector.clickCopyDebugInfoButton();
        let clipboardOk = false;
        if (clicked) {
            await new Promise(r => setTimeout(r, 300));
            const clipboardContent = await detector.readClipboard();
            if (clipboardContent) {
                clipboardOk = true;
                const truncated = clipboardContent.length > 3800 ? clipboardContent.substring(0, 3800) + '\n(truncated)' : clipboardContent;
                await bot.api.sendMessage(ch.chatId, `<b>Debug Info</b>\n\n<pre>${escapeHtml(truncated)}</pre>`, { parse_mode: 'HTML', message_thread_id: ch.threadId });
            }
        }
        const feedbackText = !clicked ? 'Button not found.' : clipboardOk ? 'Copied' : 'Could not read clipboard.';
        await ctx.answerCallbackQuery({ text: feedbackText });
    } else {
        const clicked = await detector.clickRetryButton();
        if (clicked) {
            try {
                await ctx.editMessageReplyMarkup({ reply_markup: undefined });
            } catch (e) {
                logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
            }
        }
        await ctx.answerCallbackQuery({ text: clicked ? 'Retrying...' : 'Button not found.' });
    }
    return true;
}
