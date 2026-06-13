import { Context, Bot } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CallbackDependencies } from '../callbacks';
import {
    ARTIFACT_VIEW_BTN,
    ARTIFACT_PAGE_PREFIX,
    ARTIFACT_LIST_BTN,
    buildArtifactContentUI,
    paginatePlanContent,
} from '../../ui/planUi';
import { buildTelegramKeyboard } from '../telegramAdapter';
import { channelKeyFromChannel } from '../../services/workspaceResolver';
import { artifactContentCache } from '../botState';
import { escapeHtml } from '../../utils/telegramFormatter';
import { logger } from '../../utils/logger';
import { ChatDiskScannerService } from '../../services/chatDiskScannerService';

const channelKey = channelKeyFromChannel;

/**
 * Finds the active session directory on disk.
 * Uses title matching, or falls back to the most recently modified session folder.
 */
export function getActiveSessionDir(sessionTitle: string): string | null {
    const homeDir = os.homedir();
    const brainDir = path.join(homeDir, '.gemini', 'antigravity-ide', 'brain');
    if (!fs.existsSync(brainDir)) return null;

    const wanted = sessionTitle.toLowerCase().trim();
    
    // 1. Try to find by title in disk chats
    try {
        const diskScanner = new ChatDiskScannerService();
        const chats = diskScanner.scanDiskChats();
        const foundChat = chats.find(c => {
            const itemTitle = c.title.toLowerCase().trim();
            if (!wanted || !itemTitle) return false;
            // Compare first 20-25 characters as per project rules
            const wSub = wanted.slice(0, 25);
            const iSub = itemTitle.slice(0, 25);
            return wSub.includes(iSub) || iSub.includes(wSub);
        });
        if (foundChat) {
            const dir = path.join(brainDir, foundChat.uuid);
            if (fs.existsSync(dir)) return dir;
        }
    } catch (e) {
        logger.debug('[getActiveSessionDir] Failed to find session by title:', e);
    }

    // 2. Fallback: Find the folder containing any of the core files with the latest mtime
    try {
        const folders = fs.readdirSync(brainDir);
        let latestDir: string | null = null;
        let latestMtime = 0;

        for (const f of folders) {
            const dirPath = path.join(brainDir, f);
            if (fs.statSync(dirPath).isDirectory() && f.length === 36) {
                const checkFiles = ['implementation_plan.md', 'walkthrough.md', 'task.md'];
                for (const file of checkFiles) {
                    const filePath = path.join(dirPath, file);
                    if (fs.existsSync(filePath)) {
                        const mtime = fs.statSync(filePath).mtimeMs;
                        if (mtime > latestMtime) {
                            latestMtime = mtime;
                            latestDir = dirPath;
                        }
                    }
                }
            }
        }
        if (latestDir) return latestDir;
    } catch (e) {
        logger.debug('[getActiveSessionDir] Fallback folder scan failed:', e);
    }

    return null;
}

export async function handleArtifacts(
    ctx: Context,
    data: string,
    bot: Bot,
    deps: CallbackDependencies,
    ch: any
): Promise<boolean> {
    const { bridge, chatSessionService } = deps;

    // 1. View artifact details
    if (data.startsWith(ARTIFACT_VIEW_BTN + ':')) {
        // format: art_view:projectName:targetChannelStr:fileName
        const suffix = data.substring(ARTIFACT_VIEW_BTN.length + 1);
        const [projectName, targetChannelStr, fileName] = suffix.split(':');
        if (!projectName || !targetChannelStr || !fileName) {
            await ctx.answerCallbackQuery({ text: 'Invalid callback parameters.' });
            return true;
        }

        const resolved = await deps.resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.answerCallbackQuery({ text: 'Workspace not found.' });
            return true;
        }

        const sessionInfo = await chatSessionService.getCurrentSessionInfo(resolved.cdp);
        const sessionDir = getActiveSessionDir(sessionInfo.title);
        if (!sessionDir) {
            await ctx.answerCallbackQuery({ text: 'Session directory not found.' });
            return true;
        }

        const filePath = path.join(sessionDir, fileName);
        if (!fs.existsSync(filePath)) {
            await ctx.answerCallbackQuery({ text: 'File not found on disk.' });
            return true;
        }

        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const pages = paginatePlanContent(content);
            const cacheKey = `${channelKey(ch)}:${fileName}`;
            artifactContentCache.set(cacheKey, pages);

            const { text: pageText, buttons: pageButtons } = buildArtifactContentUI(
                pages,
                0,
                projectName,
                targetChannelStr,
                fileName
            );
            const keyboard = buildTelegramKeyboard(pageButtons);
            await ctx.editMessageText(pageText, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (e: any) {
            logger.error(`[handleArtifacts] Error reading file:`, e);
            await ctx.answerCallbackQuery({ text: 'Failed to read artifact content.' });
        }
        return true;
    }

    // 2. Paginate pages of the artifact
    if (data.startsWith(ARTIFACT_PAGE_PREFIX + ':')) {
        // format: art_page:pageIndex:projectName:targetChannelStr:fileName
        const rest = data.substring(ARTIFACT_PAGE_PREFIX.length + 1);
        const parts = rest.split(':');
        if (parts.length < 4) {
            await ctx.answerCallbackQuery({ text: 'Invalid callback parameters.' });
            return true;
        }
        const pageIndex = parseInt(parts[0], 10);
        const projectName = parts[1];
        const targetChannelStr = parts[2];
        const fileName = parts.slice(3).join(':');

        const cacheKey = `${channelKey(ch)}:${fileName}`;
        let pages = artifactContentCache.get(cacheKey);

        if (!pages || isNaN(pageIndex)) {
            // Re-read if cache is missing (e.g. after bot restart)
            const resolved = await deps.resolveWorkspaceAndCdp(ch);
            if (resolved.ok) {
                const sessionInfo = await chatSessionService.getCurrentSessionInfo(resolved.cdp);
                const sessionDir = getActiveSessionDir(sessionInfo.title);
                if (sessionDir) {
                    const filePath = path.join(sessionDir, fileName);
                    if (fs.existsSync(filePath)) {
                        try {
                            const content = fs.readFileSync(filePath, 'utf-8');
                            pages = paginatePlanContent(content);
                            artifactContentCache.set(cacheKey, pages);
                        } catch (_) {}
                    }
                }
            }
        }

        if (!pages || pageIndex < 0 || pageIndex >= pages.length) {
            await ctx.answerCallbackQuery({ text: 'Page not found.' });
            return true;
        }

        const { text: pageText, buttons: pageButtons } = buildArtifactContentUI(
            pages,
            pageIndex,
            projectName,
            targetChannelStr,
            fileName
        );
        const keyboard = buildTelegramKeyboard(pageButtons);
        try {
            await ctx.editMessageText(pageText, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (e) {
            logger.debug('[editMsg] Telegram edit failed:', e);
        }
        await ctx.answerCallbackQuery({ text: `Page ${pageIndex + 1}/${pages.length}` });
        return true;
    }

    // 3. Return back to artifacts list
    if (data.startsWith(ARTIFACT_LIST_BTN + ':')) {
        // format: art_list:projectName:targetChannelStr
        const suffix = data.substring(ARTIFACT_LIST_BTN.length + 1);
        const [projectName, targetChannelStr] = suffix.split(':');
        if (!projectName || !targetChannelStr) {
            await ctx.answerCallbackQuery({ text: 'Invalid callback parameters.' });
            return true;
        }

        const resolved = await deps.resolveWorkspaceAndCdp(ch);
        if (!resolved.ok) {
            await ctx.answerCallbackQuery({ text: 'Workspace not found.' });
            return true;
        }

        const sessionInfo = await chatSessionService.getCurrentSessionInfo(resolved.cdp);
        const sessionDir = getActiveSessionDir(sessionInfo.title);
        if (!sessionDir) {
            await ctx.answerCallbackQuery({ text: 'Session directory not found.' });
            return true;
        }

        try {
            const files = fs.readdirSync(sessionDir)
                .filter(file => {
                    const fp = path.join(sessionDir, file);
                    return fs.statSync(fp).isFile() && file.endsWith('.md');
                });

            if (files.length === 0) {
                await ctx.editMessageText(
                    `<b>📂 Session Artifacts</b>\n\nNo artifacts found in session <code>${escapeHtml(sessionInfo.title)}</code>.`,
                    { parse_mode: 'HTML' }
                );
                return true;
            }

            // Group core files
            const coreFiles = ['walkthrough.md', 'implementation_plan.md', 'task.md'];
            const presentCore = files.filter(f => coreFiles.includes(f.toLowerCase()));
            const presentOthers = files.filter(f => !coreFiles.includes(f.toLowerCase()));

            // Build inline keyboard
            const buttons: any[][] = [];

            // Add core files
            for (const f of presentCore) {
                let icon = '📝';
                if (f.toLowerCase().includes('plan')) icon = '📋';
                else if (f.toLowerCase().includes('task')) icon = '✅';
                
                buttons.push([{
                    text: `${icon} ${f}`,
                    callback_data: `${ARTIFACT_VIEW_BTN}:${projectName}:${targetChannelStr}:${f}`
                }]);
            }

            // Add other files
            for (const f of presentOthers) {
                buttons.push([{
                    text: `📄 ${f}`,
                    callback_data: `${ARTIFACT_VIEW_BTN}:${projectName}:${targetChannelStr}:${f}`
                }]);
            }

            const text = `<b>📂 Session Artifacts</b>\n` +
                `Workspace: <code>${escapeHtml(projectName)}</code>\n` +
                `Session: <b>${escapeHtml(sessionInfo.title)}</b>\n\n` +
                `Select an artifact to view:`;

            await ctx.editMessageText(text, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            });
        } catch (e: any) {
            logger.error(`[handleArtifacts] Error reading files list:`, e);
            await ctx.answerCallbackQuery({ text: 'Failed to retrieve files list.' });
        }

        return true;
    }

    return false;
}
