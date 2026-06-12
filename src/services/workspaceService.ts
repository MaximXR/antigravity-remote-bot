import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { resolveSafePath } from '../middleware/sanitize';
import { logger } from '../utils/logger';

export interface RecentWorkspace {
    path: string;
    name: string;
    type: 'folder' | 'workspace' | 'file';
}

/**
 * Service for workspace filesystem operations and path validation.
 * Manages directories under WORKSPACE_BASE_DIR.
 */
export class WorkspaceService {
    private baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = baseDir;
    }

    /**
     * Update the base directory path
     */
    public setBaseDir(baseDir: string): void {
        this.baseDir = baseDir;
    }

    /**
     * Ensure the base directory exists, creating it if necessary
     */
    public ensureBaseDir(): void {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    /**
     * Return a list of subdirectories in the base directory
     */
    public scanWorkspaces(): string[] {
        this.ensureBaseDir();

        const results: string[] = [];
        const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;

            const fullPath = path.join(this.baseDir, entry.name);

            if (entry.isDirectory()) {
                try {
                    const subEntries = fs.readdirSync(fullPath);
                    const workspaceFile = subEntries.find(name => name.endsWith('.code-workspace'));
                    if (workspaceFile) {
                        results.push(`${entry.name}/${workspaceFile}`);
                    } else {
                        results.push(entry.name);
                    }
                } catch {
                    results.push(entry.name);
                }
            } else if (entry.isFile() && entry.name.endsWith('.code-workspace')) {
                results.push(entry.name);
            }
        }

        return results.sort();
    }

    /**
     * Validate a relative path and return a safe absolute path
     * @throws On path traversal detection
     */
    public validatePath(relativePath: string): string {
        return resolveSafePath(relativePath, this.baseDir);
    }

    /**
     * Get the base directory path
     */
    public getBaseDir(): string {
        return this.baseDir;
    }

    /**
     * Return the absolute path of the specified workspace
     */
    public getWorkspacePath(workspaceName: string): string {
        if (path.isAbsolute(workspaceName) || workspaceName.startsWith('empty-workspace:')) {
            return workspaceName;
        }
        return this.validatePath(workspaceName);
    }

    /**
     * Check if the specified workspace exists
     */
    public exists(workspaceName: string): boolean {
        if (workspaceName.startsWith('empty-workspace:')) {
            return true;
        }
        if (path.isAbsolute(workspaceName)) {
            return this.existsAbsolutePath(workspaceName);
        }
        try {
            const fullPath = this.validatePath(workspaceName);
            return this.existsAbsolutePath(fullPath);
        } catch {
            return false;
        }
    }

    /**
     * Check if an absolute workspace folder or file exists
     */
    public existsAbsolutePath(fullPath: string): boolean {
        try {
            return fs.existsSync(fullPath) && (fs.statSync(fullPath).isDirectory() || fullPath.endsWith('.code-workspace') || fullPath.endsWith('workspace.json'));
        } catch {
            return false;
        }
    }

    /**
     * Fetch the list of recent workspaces from the Antigravity IDE global state database
     */
    public getRecentWorkspaces(): RecentWorkspace[] {
        let appData = '';
        if (process.platform === 'win32') {
            appData = process.env.APPDATA || '';
        } else if (process.platform === 'darwin') {
            appData = path.join(process.env.HOME || '', 'Library', 'Application Support');
        } else {
            appData = path.join(process.env.HOME || '', '.config');
        }

        const dbPath = path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
        if (!fs.existsSync(dbPath)) {
            logger.warn(`[WorkspaceService] Antigravity state.vscdb not found at: ${dbPath}`);
            return [];
        }

        try {
            const db = new Database(dbPath, { readonly: true });
            const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('history.recentlyOpenedPathsList') as { value: string } | undefined;
            db.close();

            if (!row || !row.value) return [];

            const parsed = JSON.parse(row.value);
            const entries = parsed.entries || [];
            const results: RecentWorkspace[] = [];

            for (const entry of entries) {
                let uri = '';
                let type: 'folder' | 'workspace' | 'file' = 'folder';

                if (entry.folderUri) {
                    uri = entry.folderUri;
                    type = 'folder';
                } else if (entry.workspace && entry.workspace.configPath) {
                    uri = entry.workspace.configPath;
                    type = 'workspace';
                } else if (entry.fileUri) {
                    uri = entry.fileUri;
                    type = 'file';
                }

                if (!uri) continue;

                // Decode file URI (e.g. file:///e%3A/Desktop -> E:\Desktop)
                let decodedPath = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''));
                
                // On Windows, fix paths like "e:/Desktop" or "e%3A/Desktop"
                if (process.platform === 'win32') {
                    decodedPath = decodedPath.replace(/^\/([a-zA-Z]):/, '$1:').replace(/\//g, '\\');
                    if (decodedPath.startsWith('\\')) {
                        decodedPath = decodedPath.substring(1);
                    }
                }

                const name = path.basename(decodedPath);
                results.push({
                    path: decodedPath,
                    name: name || decodedPath,
                    type
                });
            }

            return results;
        } catch (e: any) {
            logger.error(`[WorkspaceService] Failed to read state.vscdb: ${e.message}`);
            return [];
        }
    }
}
