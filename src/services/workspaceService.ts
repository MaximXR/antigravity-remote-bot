import fs from 'fs';
import path from 'path';
import { resolveSafePath } from '../middleware/sanitize';

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
        return this.validatePath(workspaceName);
    }

    /**
     * Check if the specified workspace exists
     */
    public exists(workspaceName: string): boolean {
        const fullPath = this.validatePath(workspaceName);
        return fs.existsSync(fullPath) && (fs.statSync(fullPath).isDirectory() || fullPath.endsWith('.code-workspace'));
    }
}
