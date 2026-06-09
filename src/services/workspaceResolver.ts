import { logger } from '../utils/logger';
import { TelegramChannel } from './cdpBridgeManager';
import { CdpService } from './cdpService';

/**
 * Discriminated union for workspace + CDP resolution outcomes.
 */
export interface ResolveSuccess {
    ok: true;
    cdp: CdpService;
    projectName: string;
    workspacePath: string;
}

export interface ResolveError {
    ok: false;
    reason: 'no_binding' | 'cdp_failed';
    message: string;
}

export type ResolveOutcome = ResolveSuccess | ResolveError;

/**
 * Dependencies for resolveWorkspaceAndCdp, injected by the caller.
 */
export interface WorkspaceResolverDeps {
    findBinding: (channelKey: string) => { workspacePath: string } | undefined;
    getWorkspacePath: (workspaceName: string) => string;
    getOrConnect: (fullPath: string) => Promise<CdpService>;
    extractProjectName: (fullPath: string) => string;
    onConnected?: (cdp: CdpService, projectName: string, channel: TelegramChannel) => void;
}

/**
 * Build a channel key string from a TelegramChannel.
 * Private-chat / non-forum group → chatId only.
 * Forum topic → chatId:threadId.
 */
export function channelKeyFromChannel(ch: TelegramChannel): string {
    return ch.threadId ? `${ch.chatId}:${ch.threadId}` : String(ch.chatId);
}

/**
 * Resolve a TelegramChannel to a workspace binding + active CDP connection.
 *
 * Returns a discriminated union so callers can show the right error message:
 * - `no_binding` → user hasn't selected a project for this chat
 * - `cdp_failed` → binding exists but Antigravity/CDP is unreachable
 */
export async function resolveWorkspaceAndCdp(
    ch: TelegramChannel,
    deps: WorkspaceResolverDeps,
): Promise<ResolveOutcome> {
    const key = channelKeyFromChannel(ch);
    const binding = deps.findBinding(key);

    if (!binding) {
        return {
            ok: false,
            reason: 'no_binding',
            message: 'No workspace is configured for this chat. Use /workspace to select one.',
        };
    }

    try {
        const workspacePath = deps.getWorkspacePath(binding.workspacePath);
        const cdp = await deps.getOrConnect(workspacePath);
        const projectName = deps.extractProjectName(workspacePath);

        deps.onConnected?.(cdp, projectName, ch);

        return { ok: true, cdp, projectName, workspacePath };
    } catch (e: any) {
        const errorDetail = e?.message || (e ? String(e) : 'unknown error');
        logger.error(
            `[resolveWorkspaceAndCdp] Connection failed for "${binding.workspacePath}":`,
            errorDetail,
        );
        return {
            ok: false,
            reason: 'cdp_failed',
            message: `Workspace "${binding.workspacePath}" is bound but CDP connection failed: ${errorDetail}.\nIs Antigravity running with --remote-debugging-port?`,
        };
    }
}
