import { Bot, Context } from 'grammy';
import { ModeService } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { TemplateRepository } from '../database/templateRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { WorkspaceService } from '../services/workspaceService';
import { ChatSessionService } from '../services/chatSessionService';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { PromptDispatcher } from '../services/promptDispatcher';
import { CleanupCommandHandler } from '../commands/cleanupCommandHandler';
import { TelegramTopicManager } from './telegramTopicManager';
import { CdpBridge } from '../services/cdpBridgeManager';
import {
    handleApprovals,
    handleQuestions,
    handleAutoAccept,
    handleCleanup,
    handleErrorPopups,
    handleTemplates,
    handlePlans,
    handleSessions,
    handleWorkspaces,
    handleSettings,
    handleQueue,
    handleArtifacts,
} from './callbacks/index';

export interface CallbackDependencies {
    config: any;
    bridge: CdpBridge;
    modeService: ModeService;
    modelService: ModelService;
    templateRepo: TemplateRepository;
    workspaceBindingRepo: WorkspaceBindingRepository;
    chatSessionRepo: ChatSessionRepository;
    workspaceService: WorkspaceService;
    chatSessionService: ChatSessionService;
    titleGenerator: TitleGeneratorService;
    promptDispatcher: PromptDispatcher;
    cleanupHandler: CleanupCommandHandler;
    topicManager: TelegramTopicManager;
    resolveWorkspaceAndCdp: (ch: any) => Promise<any>;
    setupWorkspaceDetectors: (cdp: any, projectName: string, channel: any) => void;
    queryWorkspacePath: (wsUrl: string, title?: string) => Promise<any>;
    scanActiveWindows: () => Promise<any>;
    switchWorkspaceInternal: (ctx: Context, workspacePath: string, silent?: boolean) => Promise<any>;
}

const getChannelFromCb = (ctx: Context) => ({
    chatId: ctx.chat!.id,
    threadId: ctx.callbackQuery?.message?.message_thread_id ?? undefined,
});

export function registerCallbacks(bot: Bot, deps: CallbackDependencies) {
    bot.on('callback_query:data', async (ctx) => {
        const data = ctx.callbackQuery.data;
        const ch = getChannelFromCb(ctx);

        const handlers = [
            handleQueue,
            handleSettings,
            handleAutoAccept,
            handleWorkspaces,
            handleSessions,
            handleTemplates,
            handleApprovals,
            handleQuestions,
            handlePlans,
            handleArtifacts,
            handleErrorPopups,
            handleCleanup,
        ];

        for (const handler of handlers) {
            const handled = await handler(ctx, data, bot, deps, ch);
            if (handled) return;
        }

        await ctx.answerCallbackQuery();
    });
}
