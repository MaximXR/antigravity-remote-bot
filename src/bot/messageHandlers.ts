import { Bot, Context } from 'grammy';
import { ModeService } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { TelegramTopicManager } from './telegramTopicManager';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { ChatSessionService } from '../services/chatSessionService';
import { PromptDispatcher } from '../services/promptDispatcher';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { CdpBridge } from '../services/cdpBridgeManager';
import { ChannelContext } from '../services/messengerPort';
import {
    handleTextMessage,
    handlePhotoMessage,
    handleDocumentMessage,
    handleVoiceMessage
} from './messages/index';

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

export function registerMessageHandlers(bot: Bot, deps: MessageHandlersDependencies) {
    bot.on('message:text', async (ctx) => {
        await handleTextMessage(ctx, bot, deps);
    });

    bot.on('message:photo', async (ctx) => {
        await handlePhotoMessage(ctx, bot, deps);
    });

    bot.on('message:document', async (ctx) => {
        await handleDocumentMessage(ctx, bot, deps);
    });

    bot.on('message:voice', async (ctx) => {
        await handleVoiceMessage(ctx, bot, deps);
    });
}
