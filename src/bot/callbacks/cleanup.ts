import { Context, Bot } from 'grammy';
import { CallbackDependencies } from '../callbacks';
import {
    CLEANUP_ARCHIVE_BTN,
    CLEANUP_DELETE_BTN,
    CLEANUP_CANCEL_BTN,
    CLEANUP_DISK_ORPHANED_BTN,
    CLEANUP_DISK_ALL_INACTIVE_BTN,
} from '../../commands/cleanupCommandHandler';
import { logger } from '../../utils/logger';

const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export async function handleCleanup(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const isCleanup = data.startsWith(CLEANUP_ARCHIVE_BTN) ||
                      data.startsWith(CLEANUP_DELETE_BTN) ||
                      data === CLEANUP_CANCEL_BTN ||
                      data === CLEANUP_DISK_ORPHANED_BTN ||
                      data === CLEANUP_DISK_ALL_INACTIVE_BTN;

    if (!isCleanup) return false;

    const { cleanupHandler } = deps;

    if (data === CLEANUP_CANCEL_BTN) {
        try {
            await ctx.editMessageText('Cleanup cancelled.');
        } catch (e) {
            logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
        }
        await ctx.answerCallbackQuery({ text: 'Cancelled' });
        return true;
    }

    if (data === CLEANUP_DISK_ORPHANED_BTN || data === CLEANUP_DISK_ALL_INACTIVE_BTN) {
        const isOrphanedOnly = data === CLEANUP_DISK_ORPHANED_BTN;
        try {
            await ctx.editMessageText('🧹 Очистка файлов на диске...');
        } catch (_) {}

        const result = isOrphanedOnly 
            ? cleanupHandler.cleanupOrphanedChats() 
            : cleanupHandler.cleanupAllInactiveChats();

        const textResult = `🧹 <b>Очистка диска завершена</b>\n\n` +
            `• Удалено диалогов: <b>${result.processedCount}</b>\n` +
            `• Освобождено места: <b>${formatBytes(result.freedBytes)}</b>\n` +
            (result.errors.length > 0 ? `\n⚠️ Ошибки при удалении некоторых файлов:\n${result.errors.join('\n')}` : '');

        try {
            await ctx.editMessageText(textResult, { parse_mode: 'HTML' });
        } catch (e) {
            logger.debug('[cleanupDisk] Telegram edit failed:', e);
        }
        await ctx.answerCallbackQuery({ text: `Удалено: ${result.processedCount} чатов` });
        return true;
    }

    const isDelete = data.startsWith(CLEANUP_DELETE_BTN);
    const callbackDays = parseInt(data.split(':')[1], 10) || 7;
    const guildId = String(ch.chatId);
    const inactive = cleanupHandler.findInactiveSessions(guildId, callbackDays);

    let processed = 0;
    for (const { binding } of inactive) {
        const threadId = binding.channelId.includes(':')
            ? Number(binding.channelId.split(':')[1])
            : undefined;

        if (threadId) {
            try {
                if (isDelete) {
                    await bot.api.deleteForumTopic(ch.chatId, threadId);
                } else {
                    await bot.api.closeForumTopic(ch.chatId, threadId);
                }
            } catch (e: any) {
                logger.warn(`[Cleanup] Topic operation failed for ${binding.channelId}: ${e.message}`);
            }
        }

        cleanupHandler.cleanupByChannelId(binding.channelId);
        processed++;
    }

    const action = isDelete ? 'deleted' : 'archived';
    try {
        await ctx.editMessageText(`✅ Cleanup complete — ${processed} session(s) ${action}.`);
    } catch (e) {
        logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e);
    }
    await ctx.answerCallbackQuery({ text: `${processed} session(s) ${action}` });
    return true;
}
