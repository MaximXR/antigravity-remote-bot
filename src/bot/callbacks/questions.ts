import { Context, Bot } from 'grammy';
import { CallbackDependencies } from '../callbacks';
import { parseQuestionCustomId, getCurrentCdp } from '../../services/cdpBridgeManager';
import { channelKeyFromChannel } from '../../services/workspaceResolver';
import { mirrorResponseToTelegram } from '../tgMirror';
import { logger } from '../../utils/logger';
import { questionPendingChannels } from '../botState';
import { escapeHtml } from '../../utils/telegramFormatter';

const channelKey = channelKeyFromChannel;

export async function handleQuestions(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const questionAction = parseQuestionCustomId(data);
    if (!questionAction) return false;

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
    } = deps;

    const projectName = questionAction.projectName ?? bridge.lastActiveWorkspace;
    let detector = projectName ? bridge.pool.getQuestionDetector(projectName) : undefined;
    if (!detector) {
        const resolved = await deps.resolveWorkspaceAndCdp(ch);
        if (resolved.ok) {
            detector = bridge.pool.getQuestionDetector(resolved.projectName);
        }
    }
    if (!detector) {
        await ctx.answerCallbackQuery({ text: 'Question detector not found.' });
        return true;
    }

    if (questionAction.action === 'skip') {
        const success = await detector.clickSkip();
        if (success) {
            try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            await ctx.answerCallbackQuery({ text: 'Skip sent — waiting for IDE response…' });

            const cdp = (projectName ? bridge.pool.getConnected(projectName) : null) ?? getCurrentCdp(bridge);
            if (cdp && !promptDispatcher.isBusy(ch, cdp)) {
                if (await cdp.queryIsGenerating()) {
                    logger.info(`[QuestionCallback] Starting passive monitoring for workspace ${projectName}`);
                    const mirrorPromise = mirrorResponseToTelegram(bridge, ch, cdp, 'Skip action', {
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
                    logger.info(`[QuestionCallback] IDE is not generating, skipping passive monitoring`);
                }
            }
        } else {
            await ctx.answerCallbackQuery({ text: 'Skip button not found in IDE.' });
        }
    } else if (questionAction.action === 'answer') {
        const optionIndex = questionAction.optionIndex ?? 0;
        const info = detector.getLastDetectedInfo();
        const optionText = info?.options[optionIndex] || '';
        const lowerText = optionText.toLowerCase();

        if (lowerText.includes('other') || lowerText.includes('другое') || lowerText.includes('custom') || lowerText.includes('произвольн')) {
            const chKey = channelKey(ch);
            questionPendingChannels.set(chKey, {
                projectName: projectName || '',
                optionIndex,
            });
            
            await bot.api.sendMessage(ch.chatId, `✍️ <b>Ввод своего ответа</b>\n\nВы выбрали вариант: "<i>${escapeHtml(optionText)}</i>".\nПожалуйста, напишите ваше текстовое сообщение в ответ. Оно будет передано в поле ввода IDE.`, {
                parse_mode: 'HTML',
                message_thread_id: ch.threadId,
            });
            await ctx.answerCallbackQuery({ text: 'Please type your custom answer text.' });
        } else {
            const success = await detector.clickOption(optionIndex);
            if (success) {
                const submitted = await detector.clickSubmit();
                if (submitted) {
                    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                    await ctx.answerCallbackQuery({ text: `Option ${optionIndex + 1} submitted — waiting for IDE…` });

                    const cdp = (projectName ? bridge.pool.getConnected(projectName) : null) ?? getCurrentCdp(bridge);
                    if (cdp && !promptDispatcher.isBusy(ch, cdp)) {
                        if (await cdp.queryIsGenerating()) {
                            logger.info(`[QuestionCallback] Starting passive monitoring for workspace ${projectName}`);
                            const mirrorPromise = mirrorResponseToTelegram(bridge, ch, cdp, `Option ${optionIndex + 1} selection`, {
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
                            logger.info(`[QuestionCallback] IDE is not generating, skipping passive monitoring`);
                        }
                    }
                } else {
                    await ctx.answerCallbackQuery({ text: 'Failed to click Submit button in IDE.' });
                }
            } else {
                await ctx.answerCallbackQuery({ text: 'Option element not found in IDE.' });
            }
        }
    }
    return true;
}
