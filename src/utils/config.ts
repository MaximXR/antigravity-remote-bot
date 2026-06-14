import { ConfigLoader } from './configLoader';
import type { LogLevel } from './logger';

export type ExtractionMode = 'legacy' | 'structured';

export interface AppConfig {
    telegramBotToken: string;
    allowedUserIds: string[];
    workspaceBaseDir: string;
    autoApprove: boolean;
    autoApproveFileEdits: boolean;
    autoApproveConsoleCommands: boolean;
    autoApproveReadAccess: boolean;
    autoApproveUrlAccess: boolean;
    autoApproveBrowserAccess: boolean;
    autoApproveOtherRequests: boolean;
    autoApproveAlways: boolean;
    notifyOnAutoApprove: boolean;
    approvalMirrorMode: 'all' | 'active' | 'telegram_only';
    logLevel: LogLevel;
    extractionMode: ExtractionMode;
    useTopics: boolean;
    onlyActiveWorkspaceMessages: boolean;
    mirrorMode: 'all' | 'active' | 'telegram_only';
}

export type ResponseDeliveryMode = 'stream';

export function resolveResponseDeliveryMode(): ResponseDeliveryMode {
    return 'stream';
}

export function loadConfig(): AppConfig {
    return ConfigLoader.load();
}
