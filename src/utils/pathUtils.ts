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
    if (workspacePath.startsWith('empty-workspace:')) {
        const parts = workspacePath.split(':');
        return `empty-window-${parts[1]}-${parts[2].slice(0, 6)}`;
    }
    if (workspacePath.endsWith('workspace.json')) {
        const parsedName = parseWorkspaceJsonName(workspacePath);
        if (parsedName) {
            return parsedName;
        }
        // Fallback to parent directory name if workspace.json couldn't be parsed
        const parts = workspacePath.split(/[/\\]/).filter(Boolean);
        if (parts.length >= 2) {
            return parts[parts.length - 2];
        }
    }
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

            if (extractedPath === normPath || extractedPath.startsWith(normPath + '\\') || normPath.startsWith(extractedPath + '\\')) {
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

        if (cleanPath === normPath || cleanPath.startsWith(normPath + '\\') || normPath.startsWith(cleanPath + '\\')) {
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

/**
 * Check if the given window or workspace title represents an "untitled" (empty/unsaved) workspace page,
 * supporting multiple localization patterns (English, Russian, French, German, Spanish, Japanese, Chinese, etc.).
 */
export function isUntitledTitle(title: string): boolean {
    if (!title) return true;
    const normalized = title.toLowerCase().trim();
    if (normalized === '') return true;

    const workspaceKeywords = [
        'рабочая область',
        'workspace',
        'робоча область',
        'arbeitsbereich',
        'espace de travail',
        'área de trabajo',
        'espacio de trabajo',
        'area di lavoro',
        'ワークスペース',
        '工作区',
        '워크스페이스',
        'espaço de trabalho'
    ];
    if (workspaceKeywords.some(keyword => normalized.includes(keyword))) {
        return false;
    }

    const untitledKeywords = [
        'untitled',
        'без названия',
        'без имени',
        'без_названия',
        'без_имени',
        'unbenannt',
        'sans titre',
        'sans_titre',
        'sin título',
        'sin_título',
        'без назви',
        '無題',
        '无标题'
    ];

    return untitledKeywords.some(keyword => normalized.includes(keyword));
}

/**
 * Resolves folder paths from a workspace.json file or returns the original path.
 */
export function getWorkspaceDisplayPath(workspacePath: string): string {
    if (!workspacePath) return '';
    if (workspacePath.endsWith('workspace.json')) {
        try {
            const fs = require('fs');
            if (fs.existsSync(workspacePath)) {
                const content = fs.readFileSync(workspacePath, 'utf8');
                const parsed = JSON.parse(content);
                if (parsed.folders && Array.isArray(parsed.folders) && parsed.folders.length > 0) {
                    const path = require('path');
                    const baseDir = path.dirname(workspacePath);
                    const paths = parsed.folders.map((f: any) => {
                        const p = f.path || f.uri || '';
                        let clean = p.trim();
                        if (clean.startsWith('file:')) {
                            clean = clean.replace(/^file:\/\/\/?/, '');
                        }
                        clean = decodeURIComponent(clean);
                        clean = clean.replace(/^\/([a-zA-Z]):/, '$1:');
                        if (!path.isAbsolute(clean) && !/^[a-zA-Z]:/.test(clean)) {
                            clean = path.resolve(baseDir, clean);
                        }
                        return clean.replace(/\//g, '\\');
                    }).filter(Boolean);
                    if (paths.length > 0) {
                        return paths.join(', ');
                    }
                }
            }
        } catch {
            // ignore
        }
    }
    return workspacePath;
}

export function parseWorkspaceJsonName(workspaceJsonPath: string): string | null {
    if (!workspaceJsonPath || !workspaceJsonPath.endsWith('workspace.json')) return null;
    try {
        const fs = require('fs');
        if (fs.existsSync(workspaceJsonPath)) {
            const content = fs.readFileSync(workspaceJsonPath, 'utf8');
            const parsed = JSON.parse(content);
            if (parsed.folders && Array.isArray(parsed.folders) && parsed.folders.length > 0) {
                const path = require('path');
                const baseDir = path.dirname(workspaceJsonPath);
                const folderNames = parsed.folders.map((f: any) => {
                    const p = f.path || f.uri || '';
                    let clean = p.trim();
                    if (clean.startsWith('file:')) {
                        clean = clean.replace(/^file:\/\/\/?/, '');
                    }
                    clean = decodeURIComponent(clean);
                    clean = clean.replace(/^\/([a-zA-Z]):/, '$1:');
                    if (!path.isAbsolute(clean) && !/^[a-zA-Z]:/.test(clean)) {
                        clean = path.resolve(baseDir, clean);
                    }
                    return path.basename(clean.replace(/\//g, '\\'));
                }).filter(Boolean);

                if (folderNames.length > 1) {
                    return `🗂️ ${folderNames.join(' + ')}`;
                } else if (folderNames.length === 1) {
                    return folderNames[0];
                }
            }
        }
    } catch {
        // ignore
    }
    return null;
}

export function parseProjectNameFromTitle(title: string): string {
    if (!title) return 'Unknown';
    const parts = title.split(/\s[—–-]\s/).map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return 'Unknown';
    
    const appRegex = /^(antigravity\s*ide|antigravity|visual\s*studio\s*code|vscode|cursor|code\s*oss|code)$/i;
    
    // Filter out application name
    const filteredParts = parts.filter(p => !appRegex.test(p));
    if (filteredParts.length === 0) {
        return parts[0];
    }
    if (filteredParts.length === 1) {
        return filteredParts[0];
    }
    
    let bestPart = filteredParts[0];
    let bestScore = -100;
    
    for (const part of filteredParts) {
        let score = 0;
        const norm = part.toLowerCase();
        
        if (norm.includes('(рабочая область)') || norm.includes('(workspace)')) {
            score += 100;
        }
        if (norm.endsWith('.js') || norm.endsWith('.ts') || norm.endsWith('.json') || norm.endsWith('.md') || norm.endsWith('.py') || norm.endsWith('.html') || norm.endsWith('.css')) {
            score -= 50;
        }
        if (norm.includes('manager') || norm.includes('scratchpad') || norm.includes('extension') || norm.includes('settings') || norm.includes('настройки')) {
            score -= 30;
        }
        if (part.length > 30) {
            score -= 5;
        }
        if (part === filteredParts[0]) {
            score += 10;
        }
        
        if (score > bestScore) {
            bestScore = score;
            bestPart = part;
        }
    }
    
    return bestPart;
}


