/**
 * Helper to resolve the correct Antigravity CLI executable path based on the operating system
 * and environment variables.
 * 
 * Precedence:
 * 1. process.env.ANTIGRAVITY_PATH (Explicit override)
 * 2. OS-specific default paths (Mac: /Applications/..., Windows: %LOCALAPPDATA%\..., Linux: 'antigravity')
 */
export function getAntigravityCliPath(): string {
    // Allow user to set explicit path via ANTIGRAVITY_PATH (especially useful for Linux AppImages)
    if (process.env.ANTIGRAVITY_PATH) {
        return process.env.ANTIGRAVITY_PATH;
    }

    if (process.platform === 'darwin') {
        return '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity';
    }

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData) {
            return `${localAppData}\\Programs\\Antigravity IDE\\bin\\antigravity-ide.cmd`;
        }
        return 'antigravity-ide.cmd'; // Fallback if LOCALAPPDATA is undefined
    }

    // Default for Linux or any unknown OS, assuming 'antigravity' is in the system PATH
    return 'antigravity';
}

export function extractProjectNameFromPath(workspacePath: string): string {
    const last = workspacePath.split(/[/\\]/).filter(Boolean).pop() || '';
    if (last.endsWith('.code-workspace')) {
        return last.slice(0, -'.code-workspace'.length);
    }
    return last;
}

export function isTitleMatch(title: string, projectName: string): boolean {
    if (!title) return false;
    const normProj = projectName.toLowerCase().trim();
    const parts = title.split(/\s[—–-]\s/).map(p => p.toLowerCase().trim());
    
    if (parts.length < 2) {
        return parts[0] === normProj;
    }

    const appRegex = /^(antigravity\s*ide|antigravity|visual\s*studio\s*code|vscode|cursor|code\s*oss|code)$/i;
    const appIndex = parts.findIndex(p => appRegex.test(p));

    let projectPart = '';
    if (appIndex > 0) {
        projectPart = parts[appIndex - 1];
    } else if (appIndex === 0) {
        projectPart = parts[1] || '';
    } else {
        projectPart = parts[parts.length - 2] || parts[0];
    }
    
    // Remove workspace suffix (e.g., "(workspace)" or "(рабочая область)")
    const cleanProjectPart = projectPart.replace(/\s*\([^)]+\)$/, '').trim();
    
    if (cleanProjectPart === normProj) return true;
    if (cleanProjectPart.endsWith('.code-workspace') && cleanProjectPart.slice(0, -'.code-workspace'.length).trim() === normProj) {
        return true;
    }
    return false;
}

export function isWorkspaceMatch(
    detected: string,
    projectName: string,
    workspacePath: string
): boolean {
    let cleanDetected = detected.trim();
    try {
        if (cleanDetected.includes('%')) {
            cleanDetected = decodeURIComponent(cleanDetected);
        }
    } catch {
        // Ignore decoding errors
    }

    const normDetected = cleanDetected.toLowerCase();
    const normProj = projectName.toLowerCase().trim();
    const normPath = workspacePath.toLowerCase().replace(/\//g, '\\').trim();

    const isPathOrUri = (str: string): boolean => {
        return str.includes('\\') || str.includes('/') || str.includes(':');
    };

    if (isPathOrUri(normDetected)) {
        // Handle URL parameters for folder/workspace if present
        const folderMatch = normDetected.match(/(?:folder|workspace)=([^&]+)/);
        if (folderMatch) {
            let extractedPath = folderMatch[1];
            if (extractedPath.startsWith('file:')) {
                extractedPath = extractedPath.replace(/^file:\/\/\/?/, '');
            }
            extractedPath = extractedPath.replace(/^\/([a-z]):/, '$1:').replace(/\//g, '\\');

            if (extractedPath === normPath || extractedPath === normPath + '\\') {
                return true;
            }

            const lastSeg = extractedPath.split(/[\\/]/).filter(Boolean).pop() || '';
            if (lastSeg === normProj) {
                return true;
            }

            return false;
        }

        let cleanPath = normDetected;
        if (cleanPath.startsWith('file:')) {
            cleanPath = cleanPath.replace(/^file:\/\/\/?/, '');
        }
        cleanPath = cleanPath.replace(/^[a-z0-9-]+:\/\/[^/]+\//, '');
        cleanPath = cleanPath.replace(/^\/([a-z]):/, '$1:').replace(/\//g, '\\');

        if (cleanPath === normPath || cleanPath === normPath + '\\') {
            return true;
        }

        const lastSeg = cleanPath.split(/[\\/]/).filter(Boolean).pop() || '';
        if (lastSeg === normProj) {
            return true;
        }

        return false;
    }

    if (normDetected.includes(' - ') || normDetected.includes(' — ') || normDetected.includes(' – ')) {
        return isTitleMatch(cleanDetected, projectName);
    }

    return normDetected === normProj;
}

/**
 * Get a platform-appropriate hint for starting Antigravity with CDP.
 *
 * Used in user-facing messages (Telegram messages, CLI doctor, logs).
 */
export function getAntigravityCdpHint(port: number = 9222): string {
    const APP_NAME = 'Antigravity';
    switch (process.platform) {
        case 'darwin':
            return `open -a ${APP_NAME} --args --remote-debugging-port=${port}`;
        case 'win32':
            return `${APP_NAME}.exe --remote-debugging-port=${port}`;
        default:
            return `${APP_NAME.toLowerCase()} --remote-debugging-port=${port}`;
    }
}
