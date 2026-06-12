import { Context, Bot } from 'grammy';
import { MessageHandlersDependencies } from '../messageHandlers';
import { ChannelContext } from '../../services/messengerPort';
import { channelKeyFromChannel } from '../../services/workspaceResolver';
import { normalizeForHash } from '../../services/userMessageDetector';
import { telegramSentPrompts } from '../botState';
import {
    downloadTelegramImages,
    cleanupInboundImageAttachments,
    isImageAttachment
} from '../../utils/imageHandler';
import { logger } from '../../utils/logger';

const channelKey = channelKeyFromChannel;

interface PendingMediaGroup {
    timer: NodeJS.Timeout;
    ch: ChannelContext;
    photos: Array<{ file_id: string; file_size?: number }>;
    documents: Array<{ file_id: string; file_size?: number; mime_type?: string; file_name?: string }>;
    captions: string[];
    messageIds: number[];
    ctx: Context;
}

const pendingMediaGroups = new Map<string, PendingMediaGroup>();

const getChannel = (ctx: Context): ChannelContext => ({
    chatId: ctx.chat!.id,
    threadId: ctx.message?.message_thread_id ?? undefined,
});

const handleMediaGroup = async (mediaGroupId: string, ch: ChannelContext, ctx: Context, bot: Bot, deps: MessageHandlersDependencies) => {
    const group = pendingMediaGroups.get(mediaGroupId);
    if (!group) return;
    pendingMediaGroups.delete(mediaGroupId);

    const {
        config,
        bridge,
        chatSessionService,
        chatSessionRepo,
        topicManager,
        titleGenerator,
        promptDispatcher,
        resolveWorkspaceAndCdp,
    } = deps;

    const caption = group.captions.filter(Boolean).join('\n') || 'Please review the attached images and respond accordingly.';
    const resolved = await resolveWorkspaceAndCdp(group.ch);
    if (!resolved.ok) {
        await group.ctx.reply(resolved.message);
        return;
    }

    const allItems = [...group.photos, ...group.documents];
    const inboundImages = await downloadTelegramImages(
        bot.api,
        config.telegramBotToken,
        allItems,
        String(group.messageIds[0]),
    );

    const busy = promptDispatcher.isBusy(group.ch, resolved.cdp);
    if (busy) {
        const normalized = normalizeForHash(caption);
        telegramSentPrompts.add(normalized);

        resolved.cdp.injectMessageWithImageFiles(caption, inboundImages.map(i => i.localPath))
            .catch((err: any) => {
                logger.error('[TelegramQueue:mediaGroup] Failed to inject:', err);
                group.ctx.reply(`❌ Failed to send album to IDE: ${err.message}`).catch(() => {});
                telegramSentPrompts.delete(normalized);
            })
            .finally(() => {
                cleanupInboundImageAttachments(inboundImages).catch(() => {});
            });
        return;
    }

    promptDispatcher.send({
        channel: group.ch,
        prompt: caption,
        cdp: resolved.cdp,
        inboundImages,
        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
    }).catch((e) => logger.error('[mediaGroup] dispatch failed:', e))
     .finally(() => cleanupInboundImageAttachments(inboundImages).catch(() => {}));
};

export async function handlePhotoMessage(
    ctx: Context,
    bot: Bot,
    deps: MessageHandlersDependencies
): Promise<void> {
    const ch = getChannel(ctx);
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    const largest = photos[photos.length - 1];
    const caption = ctx.message.caption?.trim() || '';

    const mediaGroupId = ctx.message.media_group_id;
    if (mediaGroupId) {
        let group = pendingMediaGroups.get(mediaGroupId);
        if (!group) {
            group = {
                timer: null as any,
                ch,
                photos: [],
                documents: [],
                captions: [],
                messageIds: [],
                ctx,
            };
            pendingMediaGroups.set(mediaGroupId, group);
        }
        group.photos.push(largest);
        if (caption) group.captions.push(caption);
        group.messageIds.push(ctx.message.message_id);
        if (group.timer) clearTimeout(group.timer);
        group.timer = setTimeout(() => handleMediaGroup(mediaGroupId, ch, ctx, bot, deps), 800);
        return;
    }

    const {
        config,
        resolveWorkspaceAndCdp,
        promptDispatcher,
        chatSessionService,
        chatSessionRepo,
        topicManager,
        titleGenerator,
    } = deps;

    const resolved = await resolveWorkspaceAndCdp(ch);
    if (!resolved.ok) {
        await ctx.reply(resolved.message);
        return;
    }

    const inboundImages = await downloadTelegramImages(
        bot.api,
        config.telegramBotToken,
        [largest],
        String(ctx.message.message_id),
    );

    const busy = promptDispatcher.isBusy(ch, resolved.cdp);
    if (busy) {
        const promptText = caption || 'Please review the attached images and respond accordingly.';
        const normalized = normalizeForHash(promptText);
        telegramSentPrompts.add(normalized);

        resolved.cdp.injectMessageWithImageFiles(promptText, inboundImages.map(i => i.localPath))
            .catch((err: any) => {
                logger.error('[TelegramQueue:photo] Failed to inject:', err);
                ctx.reply(`❌ Failed to send photo to IDE: ${err.message}`).catch(() => {});
                telegramSentPrompts.delete(normalized);
            })
            .finally(() => {
                cleanupInboundImageAttachments(inboundImages).catch(() => {});
            });
        return;
    }

    promptDispatcher.send({
        channel: ch,
        prompt: caption || 'Please review the attached images and respond accordingly.',
        cdp: resolved.cdp,
        inboundImages,
        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
    }).catch((e) => logger.error('[photoMsg] dispatch failed:', e))
     .finally(() => cleanupInboundImageAttachments(inboundImages).catch(() => {}));
}

export async function handleDocumentMessage(
    ctx: Context,
    bot: Bot,
    deps: MessageHandlersDependencies
): Promise<void> {
    const doc = ctx.message?.document;
    if (!doc) return;

    if (!isImageAttachment(doc.mime_type, doc.file_name)) {
        return;
    }

    const ch = getChannel(ctx);
    const caption = ctx.message.caption?.trim() || '';

    const mediaGroupId = ctx.message.media_group_id;
    if (mediaGroupId) {
        let group = pendingMediaGroups.get(mediaGroupId);
        if (!group) {
            group = {
                timer: null as any,
                ch,
                photos: [],
                documents: [],
                captions: [],
                messageIds: [],
                ctx,
            };
            pendingMediaGroups.set(mediaGroupId, group);
        }
        group.documents.push(doc);
        if (caption) group.captions.push(caption);
        group.messageIds.push(ctx.message.message_id);
        if (group.timer) clearTimeout(group.timer);
        group.timer = setTimeout(() => handleMediaGroup(mediaGroupId, ch, ctx, bot, deps), 800);
        return;
    }

    const {
        config,
        resolveWorkspaceAndCdp,
        promptDispatcher,
        chatSessionService,
        chatSessionRepo,
        topicManager,
        titleGenerator,
    } = deps;

    const resolved = await resolveWorkspaceAndCdp(ch);
    if (!resolved.ok) {
        await ctx.reply(resolved.message);
        return;
    }

    const inboundImages = await downloadTelegramImages(
        bot.api,
        config.telegramBotToken,
        [doc],
        String(ctx.message.message_id),
    );

    const busy = promptDispatcher.isBusy(ch, resolved.cdp);
    if (busy) {
        const promptText = caption || 'Please review the attached images and respond accordingly.';
        const normalized = normalizeForHash(promptText);
        telegramSentPrompts.add(normalized);

        resolved.cdp.injectMessageWithImageFiles(promptText, inboundImages.map(i => i.localPath))
            .catch((err: any) => {
                logger.error('[TelegramQueue:document] Failed to inject:', err);
                ctx.reply(`❌ Failed to send file to IDE: ${err.message}`).catch(() => {});
                telegramSentPrompts.delete(normalized);
            })
            .finally(() => {
                cleanupInboundImageAttachments(inboundImages).catch(() => {});
            });
        return;
    }

    promptDispatcher.send({
        channel: ch,
        prompt: caption || 'Please review the attached images and respond accordingly.',
        cdp: resolved.cdp,
        inboundImages,
        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
    }).catch((e) => logger.error('[documentMsg] dispatch failed:', e))
     .finally(() => cleanupInboundImageAttachments(inboundImages).catch(() => {}));
}
