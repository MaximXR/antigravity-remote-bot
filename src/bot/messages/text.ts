import { Context, Bot } from 'grammy';
import { MessageHandlersDependencies } from '../messageHandlers';
import { getCurrentCdp, registerApprovalSessionChannel } from '../../services/cdpBridgeManager';
import { channelKeyFromChannel } from '../../services/workspaceResolver';
import { parseMessageContent } from '../../commands/messageParser';
import { handleScreenshot } from '../../ui/screenshotUi';
import { normalizeForHash } from '../../services/userMessageDetector';
import {
    telegramSentPrompts,
    planEditPendingChannels,
    questionPendingChannels
} from '../botState';
import { mirrorResponseToTelegram } from '../tgMirror';
import { logger } from '../../utils/logger';

const channelKey = channelKeyFromChannel;

const getChannel = (ctx: Context) => ({
    chatId: ctx.chat!.id,
    threadId: ctx.message?.message_thread_id ?? undefined,
});

export async function handleTextMessage(
    ctx: Context,
    bot: Bot,
    deps: MessageHandlersDependencies
): Promise<void> {
    const ch = getChannel(ctx);
    const key = channelKey(ch);
    const text = ctx.message?.text?.trim();

    if (!text) return;

    const {
        bridge,
        chatSessionService,
        chatSessionRepo,
        topicManager,
        titleGenerator,
        modelService,
        modeService,
        workspaceBindingRepo,
        promptDispatcher,
        slashCommandHandler,
        resolveWorkspaceAndCdp,
        commands,
    } = deps;

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

    // Question text input interception
    const pendingQuestion = questionPendingChannels.get(key);
    if (pendingQuestion) {
        questionPendingChannels.delete(key);
        
        const projectName = pendingQuestion.projectName;
        const optionIndex = pendingQuestion.optionIndex;

        const detector = projectName ? bridge.pool.getQuestionDetector(projectName) : undefined;
        if (!detector) {
            await ctx.reply('Детектор вопросов не найден для этого проекта.');
            return;
        }

        await ctx.reply('Отправка ответа в IDE...');
        
        const success = await detector.submitTextAnswer(optionIndex, text);
        if (success) {
            await ctx.reply('Ответ успешно отправлен в IDE.');
            
            const cdp = (projectName ? bridge.pool.getConnected(projectName) : null) ?? getCurrentCdp(bridge);
            if (cdp && !promptDispatcher.isBusy(ch, cdp)) {
                if (await cdp.queryIsGenerating()) {
                    logger.info(`[QuestionTextInput] Starting passive monitoring for workspace ${projectName}`);
                    const mirrorPromise = mirrorResponseToTelegram(bridge, ch, cdp, `Custom answer text submission`, {
                        chatSessionService,
                        chatSessionRepo,
                        topicManager,
                        titleGenerator,
                        modelService,
                        modeService,
                        workspaceBindingRepo
                    });
                    promptDispatcher.acquireLock(ch, cdp, mirrorPromise);
                } else {
                    logger.info(`[QuestionTextInput] IDE is not generating, skipping passive monitoring`);
                }
            }
        } else {
            await ctx.reply('Не удалось отправить ответ. Пожалуйста, проверьте IDE.');
        }
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

    promptDispatcher.send({
        channel: ch,
        prompt: text,
        cdp: resolved.cdp,
        inboundImages: [],
        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
    }).catch((e) => logger.error('[textMsg] dispatch failed:', e));
}
