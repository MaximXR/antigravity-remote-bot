import { Bot, Context, InlineKeyboard } from 'grammy';
import path from 'path';

import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { loadConfig } from '../utils/config';
import { parseMessageContent } from '../commands/messageParser';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { ModeService } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { TelegramTopicManager } from './telegramTopicManager';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { ChatSessionService } from '../services/chatSessionService';
import { PromptDispatcher } from '../services/promptDispatcher';
import {
    CdpBridge,
    getCurrentCdp,
    registerApprovalSessionChannel
} from '../services/cdpBridgeManager';
import { ChannelContext } from '../services/messengerPort';
import { channelKeyFromChannel } from '../services/workspaceResolver';
import { normalizeForHash } from '../services/userMessageDetector';
import {
    telegramSentPrompts,
    planEditPendingChannels
} from './botState';
import { mirrorResponseToTelegram } from './tgMirror';
import { handleScreenshot } from '../ui/screenshotUi';
import {
    downloadTelegramImages,
    cleanupInboundImageAttachments,
    isImageAttachment
} from '../utils/imageHandler';
import {
    checkWhisperAvailability,
    downloadTelegramVoice,
    transcribeVoice
} from '../utils/voiceHandler';

const channelKey = channelKeyFromChannel;

export interface MessageHandlersDependencies {
    config: any;
    bridge: CdpBridge;
    modeService: ModeService;
    modelService: ModelService;
    chatSessionRepo: ChatSessionRepository;
    workspaceBindingRepo: WorkspaceBindingRepository;
    chatSessionService: ChatSessionService;
    titleGenerator: TitleGeneratorService;
    promptDispatcher: PromptDispatcher;
    slashCommandHandler: SlashCommandHandler;
    topicManager: TelegramTopicManager;
    resolveWorkspaceAndCdp: (ch: ChannelContext) => Promise<any>;
    commands: {
        handleStatus: (ctx: Context) => Promise<void>;
    };
}

// Media group (album) aggregator
interface PendingMediaGroup {
    timer: NodeJS.Timeout;
    ch: ChannelContext;
    photos: Array<{ file_id: string; file_size?: number }>;
    documents: Array<{ file_id: string; file_size?: number; mime_type?: string; file_name?: string }>;
    captions: string[];
    messageIds: number[];
    ctx: Context;
}

export function registerMessageHandlers(bot: Bot, deps: MessageHandlersDependencies) {
    const {
        config,
        bridge,
        modeService,
        modelService,
        chatSessionRepo,
        workspaceBindingRepo,
        chatSessionService,
        titleGenerator,
        promptDispatcher,
        slashCommandHandler,
        topicManager,
        resolveWorkspaceAndCdp,
        commands,
    } = deps;

    // Helper to build ChannelContext from context
    const getChannel = (ctx: Context): ChannelContext => ({
        chatId: ctx.chat!.id,
        threadId: ctx.message?.message_thread_id ?? undefined,
    });

    bot.on('message:text', async (ctx) => {
        const ch = getChannel(ctx);
        const key = channelKey(ch);
        const text = ctx.message.text.trim();

        if (!text) return;

        // Plan edit interception
        const pendingPlanEdit = planEditPendingChannels.get(key);
        if (pendingPlanEdit) {
            if (text === '/cancel') {
                planEditPendingChannels.delete(key);
                await ctx.reply('Plan edit cancelled.');
                return;
            }

            planEditPendingChannels.delete(key);
            const editPrompt = `Please revise the plan based on the following feedback:\n\n${text}`;
            const resolved = await resolveWorkspaceAndCdp(ch);
            const cdp = (resolved.ok ? resolved.cdp : null) ?? getCurrentCdp(bridge);
            if (!cdp) {
                await ctx.reply('Not connected to CDP.');
                return;
            }
            await ctx.reply('Sending plan edit...');
            promptDispatcher.send({
                channel: ch,
                prompt: editPrompt,
                cdp,
                inboundImages: [],
                options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
            }).catch((e) => logger.error('[planEdit] dispatch failed:', e));
            return;
        }

        // Check if it looks like a text command
        const parsed = parseMessageContent(text);
        if (parsed.isCommand && parsed.commandName) {
            if (parsed.commandName === 'autoaccept') {
                const result = bridge.autoAccept.handle(parsed.args?.[0]);
                await ctx.reply(result.message);
                return;
            }

            if (parsed.commandName === 'screenshot') {
                await handleScreenshot(
                    async (input, caption) => { await ctx.replyWithPhoto(input, { caption }); },
                    async (text) => { await ctx.reply(text); },
                    getCurrentCdp(bridge),
                );
                return;
            }

            if (parsed.commandName === 'status') {
                await commands.handleStatus(ctx);
                return;
            }

            const result = await slashCommandHandler.handleCommand(parsed.commandName, parsed.args || []);
            await ctx.reply(result.message);

            if (result.prompt) {
                const cdp = getCurrentCdp(bridge);
                if (cdp) {
                    promptDispatcher.send({
                        channel: ch,
                        prompt: result.prompt,
                        cdp,
                        inboundImages: [],
                        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
                    }).catch((e) => logger.error('[slashCmd] dispatch failed:', e));
                } else {
                    await ctx.reply('Not connected to CDP. Send a message first to connect to a project.');
                }
            }
            return;
        }

        // Regular message — route to Antigravity
        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.reply(resolved.message);
            return;
        }

        // ── Concurrency gate: check if workspace is busy ────────────────────
        const busy = promptDispatcher.isBusy(ch, resolved.cdp);
        if (busy) {
            const normalized = normalizeForHash(text);
            telegramSentPrompts.add(normalized);

            resolved.cdp.injectMessage(text).catch((err: any) => {
                logger.error('[TelegramQueue] Failed to inject queued message:', err);
                ctx.reply(`❌ Failed to send message to IDE: ${err.message}`).catch(() => {});
                telegramSentPrompts.delete(normalized);
            });
            return;
        }
        // ── End concurrency gate ────────────────────────────────────────────

        const session = chatSessionRepo.findByChannelId(key);
        if (session?.displayName) {
            registerApprovalSessionChannel(bridge, resolved.projectName, session.displayName, ch);
        }

        const userMsgDetector = bridge.pool.getUserMessageDetector?.(resolved.projectName);
        if (userMsgDetector) userMsgDetector.addEchoHash(text);

        // Fire-and-forget: do NOT await so Grammy can process the next update immediately.
        // The lock is set synchronously inside send() before its first await,
        // so isBusy() will see it when the next message handler runs.
        promptDispatcher.send({
            channel: ch,
            prompt: text,
            cdp: resolved.cdp,
            inboundImages: [],
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[textMsg] dispatch failed:', e));
    });

    const pendingMediaGroups = new Map<string, PendingMediaGroup>();

    const handleMediaGroup = async (mediaGroupId: string, ch: ChannelContext, ctx: Context) => {
        const group = pendingMediaGroups.get(mediaGroupId);
        if (!group) return;
        pendingMediaGroups.delete(mediaGroupId);

        const caption = group.captions.filter(Boolean).join('\n') || 'Please review the attached images and respond accordingly.';
        const resolved = await resolveWorkspaceAndCdp(group.ch);
        if (!resolved.ok) { await group.ctx.reply(resolved.message); return; }

        const allItems = [...group.photos, ...group.documents];
        const inboundImages = await downloadTelegramImages(
            bot.api,
            config.telegramBotToken,
            allItems,
            String(group.messageIds[0]),
        );

        // ── Concurrency gate ────────────────────────────────────────────────
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
        // ── End concurrency gate ────────────────────────────────────────────

        promptDispatcher.send({
            channel: group.ch,
            prompt: caption,
            cdp: resolved.cdp,
            inboundImages,
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[mediaGroup] dispatch failed:', e))
         .finally(() => cleanupInboundImageAttachments(inboundImages).catch(() => {}));
    };

    // Photo message handler
    bot.on('message:photo', async (ctx) => {
        const ch = getChannel(ctx);
        const photos = ctx.message.photo;
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
            group.timer = setTimeout(() => handleMediaGroup(mediaGroupId, ch, ctx), 800);
            return;
        }

        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) { await ctx.reply(resolved.message); return; }

        const inboundImages = await downloadTelegramImages(
            bot.api,
            config.telegramBotToken,
            [largest],
            String(ctx.message.message_id),
        );

        // ── Concurrency gate ────────────────────────────────────────────────
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
        // ── End concurrency gate ────────────────────────────────────────────

        // Fire-and-forget; cleanup images after dispatch completes (not immediately)
        promptDispatcher.send({
            channel: ch,
            prompt: caption || 'Please review the attached images and respond accordingly.',
            cdp: resolved.cdp,
            inboundImages,
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[photoMsg] dispatch failed:', e))
         .finally(() => cleanupInboundImageAttachments(inboundImages).catch(() => {}));
    });

    // Document (file) message handler - handle uncompressed images
    bot.on('message:document', async (ctx) => {
        const doc = ctx.message.document;
        if (!doc) return;

        // Check if the document is an image
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
            group.timer = setTimeout(() => handleMediaGroup(mediaGroupId, ch, ctx), 800);
            return;
        }

        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) { await ctx.reply(resolved.message); return; }

        const inboundImages = await downloadTelegramImages(
            bot.api,
            config.telegramBotToken,
            [doc],
            String(ctx.message.message_id),
        );

        // ── Concurrency gate ────────────────────────────────────────────────
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
        // ── End concurrency gate ────────────────────────────────────────────

        promptDispatcher.send({
            channel: ch,
            prompt: caption || 'Please review the attached images and respond accordingly.',
            cdp: resolved.cdp,
            inboundImages,
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[documentMsg] dispatch failed:', e))
         .finally(() => cleanupInboundImageAttachments(inboundImages).catch(() => {}));
    });

    // Voice message handler (voice-to-prompt via local Whisper transcription)
    bot.on('message:voice', async (ctx) => {
        const ch = getChannel(ctx);

        const whisperIssue = checkWhisperAvailability();
        if (whisperIssue) {
            await ctx.reply(whisperIssue);
            return;
        }

        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.reply(resolved.message);
            return;
        }

        await ctx.reply('🎙️ Transcribing voice message...');

        let voicePath: string;
        try {
            voicePath = await downloadTelegramVoice(bot.api, config.telegramBotToken, ctx.message.voice);
        } catch (error: any) {
            logger.error('[Voice] Download failed:', error?.message || error);
            await ctx.reply('❌ Could not download voice message. Please try again.');
            return;
        }

        const transcript = await transcribeVoice(voicePath);
        if (!transcript) {
            await ctx.reply('❌ Could not transcribe voice message. Please try again or type your prompt.');
            return;
        }

        // Check if transcription is a slash command
        const parsed = parseMessageContent(transcript);
        if (parsed.isCommand && parsed.commandName) {
            const result = await slashCommandHandler.handleCommand(parsed.commandName, parsed.args || []);
            await ctx.reply(`🎙️ "${transcript}"\n\n${result.message}`);

            if (result.prompt) {
                const cdp = getCurrentCdp(bridge);
                if (cdp) {
                    promptDispatcher.send({
                        channel: ch,
                        prompt: result.prompt,
                        cdp,
                        inboundImages: [],
                        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
                    }).catch((e) => logger.error('[voiceCmd] dispatch failed:', e));
                }
            }
            return;
        }

        await ctx.reply(`📝 "${transcript}"`);

        // ── Concurrency gate ────────────────────────────────────────────────
        const busy = promptDispatcher.isBusy(ch, resolved.cdp);
        if (busy) {
            const normalized = normalizeForHash(transcript);
            telegramSentPrompts.add(normalized);

            resolved.cdp.injectMessage(transcript).catch((err: any) => {
                logger.error('[TelegramQueue:voice] Failed to inject:', err);
                ctx.reply(`❌ Failed to send voice transcription to IDE: ${err.message}`).catch(() => {});
                telegramSentPrompts.delete(normalized);
            });
            return;
        }
        // ── End concurrency gate ────────────────────────────────────────────

        const userMsgDetector = bridge.pool.getUserMessageDetector?.(resolved.projectName);
        if (userMsgDetector) userMsgDetector.addEchoHash(transcript);

        // Fire-and-forget: same pattern as text handler
        promptDispatcher.send({
            channel: ch,
            prompt: transcript,
            cdp: resolved.cdp,
            inboundImages: [],
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[voiceMsg] dispatch failed:', e));
    });
}
