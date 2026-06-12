import { Context, Bot } from 'grammy';
import { MessageHandlersDependencies } from '../messageHandlers';
import { getCurrentCdp } from '../../services/cdpBridgeManager';
import { channelKeyFromChannel } from '../../services/workspaceResolver';
import { parseMessageContent } from '../../commands/messageParser';
import { normalizeForHash } from '../../services/userMessageDetector';
import { telegramSentPrompts } from '../botState';
import {
    checkWhisperAvailability,
    downloadTelegramVoice,
    transcribeVoice
} from '../../utils/voiceHandler';
import { logger } from '../../utils/logger';

const channelKey = channelKeyFromChannel;

const getChannel = (ctx: Context) => ({
    chatId: ctx.chat!.id,
    threadId: ctx.message?.message_thread_id ?? undefined,
});

export async function handleVoiceMessage(
    ctx: Context,
    bot: Bot,
    deps: MessageHandlersDependencies
): Promise<void> {
    const ch = getChannel(ctx);

    const whisperIssue = checkWhisperAvailability();
    if (whisperIssue) {
        await ctx.reply(whisperIssue);
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
        slashCommandHandler,
        bridge,
    } = deps;

    const resolved = await resolveWorkspaceAndCdp(ch);
    if (!resolved.ok) {
        await ctx.reply(resolved.message);
        return;
    }

    await ctx.reply('🎙️ Transcribing voice message...');

    let voicePath: string;
    try {
        voicePath = await downloadTelegramVoice(bot.api, config.telegramBotToken, ctx.message!.voice!);
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

    const userMsgDetector = bridge.pool.getUserMessageDetector?.(resolved.projectName);
    if (userMsgDetector) userMsgDetector.addEchoHash(transcript);

    promptDispatcher.send({
        channel: ch,
        prompt: transcript,
        cdp: resolved.cdp,
        inboundImages: [],
        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
    }).catch((e) => logger.error('[voiceMsg] dispatch failed:', e));
}
