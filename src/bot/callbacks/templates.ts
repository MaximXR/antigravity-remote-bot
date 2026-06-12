import { Context, Bot } from 'grammy';
import { CallbackDependencies } from '../callbacks';
import { TEMPLATE_BTN_PREFIX, parseTemplateButtonId } from '../../ui/templateUi';
import { getCurrentCdp } from '../../services/cdpBridgeManager';
import { logger } from '../../utils/logger';

export async function handleTemplates(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    if (!data.startsWith(TEMPLATE_BTN_PREFIX)) return false;

    const {
        templateRepo,
        bridge,
        chatSessionService,
        chatSessionRepo,
        topicManager,
        titleGenerator,
        promptDispatcher,
    } = deps;

    const templateId = parseTemplateButtonId(data);
    if (isNaN(templateId)) {
        await ctx.answerCallbackQuery({ text: 'Invalid template.' });
        return true;
    }
    const template = templateRepo.findById(templateId);
    if (!template) {
        await ctx.answerCallbackQuery({ text: 'Template not found.' });
        return true;
    }

    const resolved = await deps.resolveWorkspaceAndCdp(ch);
    if (!resolved.ok) {
        const cdp = getCurrentCdp(bridge);
        if (!cdp) {
            await ctx.answerCallbackQuery({ text: 'Not connected.' });
            return true;
        }
        promptDispatcher.send({
            channel: ch,
            prompt: template.prompt,
            cdp,
            inboundImages: [],
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator }
        }).catch((e) => logger.error('[template] dispatch failed:', e));
    } else {
        promptDispatcher.send({
            channel: ch,
            prompt: template.prompt,
            cdp: resolved.cdp,
            inboundImages: [],
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator }
        }).catch((e) => logger.error('[template] dispatch failed:', e));
    }
    await ctx.answerCallbackQuery({ text: `Running: ${template.name}` });
    return true;
}
