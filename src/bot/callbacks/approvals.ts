import { Context, Bot } from 'grammy';
import { CallbackDependencies } from '../callbacks';
import { parseApprovalCustomId, registerApprovalSessionChannel, getCurrentCdp } from '../../services/cdpBridgeManager';
import { resolveWorkspaceAndCdp, channelKeyFromChannel } from '../../services/workspaceResolver';
import { mirrorResponseToTelegram } from '../tgMirror';
import { logger } from '../../utils/logger';

const channelKey = channelKeyFromChannel;

export async function handleApprovals(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const approvalAction = parseApprovalCustomId(data);
    if (!approvalAction) return false;

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

    const projectName = approvalAction.projectName ?? bridge.lastActiveWorkspace;
    let detector = projectName ? bridge.pool.getApprovalDetector(projectName) : undefined;
    if (!detector) {
        const resolved = await deps.resolveWorkspaceAndCdp(ch);
        if (resolved.ok) {
            detector = bridge.pool.getApprovalDetector(resolved.projectName);
        }
    }
    if (!detector) {
        await ctx.answerCallbackQuery({ text: 'Approval detector not found.' });
        return true;
    }

    let success = false;
    let actionLabel = '';
    if (approvalAction.action === 'approve') {
        success = await detector.approveButton();
        actionLabel = 'Allow';
    } else if (approvalAction.action === 'always_allow') {
        success = await detector.alwaysAllowButton();
        actionLabel = 'Allow Chat';
    } else {
        success = await detector.denyButton();
        actionLabel = 'Deny';
    }

    if (success) {
        await ctx.answerCallbackQuery({ text: `${actionLabel} sent — waiting for IDE response…` });

        const cdp = (projectName ? bridge.pool.getConnected(projectName) : null) ?? getCurrentCdp(bridge);
        if (cdp && !promptDispatcher.isBusy(ch, cdp)) {
            if (await cdp.queryIsGenerating()) {
                logger.info(`[ApprovalCallback] Starting passive monitoring for workspace ${projectName}`);
                const mirrorPromise = mirrorResponseToTelegram(bridge, ch, cdp, `${actionLabel} action`, {
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
                logger.info(`[ApprovalCallback] IDE is not generating, skipping passive monitoring`);
            }
        }
    } else {
        await ctx.answerCallbackQuery({ text: 'Button not found in IDE. Use /allow or /deny to retry.' });
    }
    return true;
}
