import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

export interface DiskChatInfo {
    uuid: string;
    title: string;
    isActive: boolean;
    sizeBytes: number;
    sizeStr: string;
    fileCount: number;
    createdAt: number;
    createdAtStr: string;
}

export class ChatDiskScannerService {
    private readonly brainDir: string;
    private readonly conversationsDir: string;
    private readonly annotationsDir: string;
    private readonly dbPath: string;

    constructor() {
        const homeDir = os.homedir();
        
        // Resolve path to Antigravity IDE directories
        this.brainDir = path.join(homeDir, '.gemini', 'antigravity-ide', 'brain');
        this.conversationsDir = path.join(homeDir, '.gemini', 'antigravity-ide', 'conversations');
        this.annotationsDir = path.join(homeDir, '.gemini', 'antigravity-ide', 'annotations');

        // Resolve global state DB path depending on platform
        if (process.platform === 'win32') {
            const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
            this.dbPath = path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
        } else if (process.platform === 'darwin') {
            this.dbPath = path.join(homeDir, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
        } else {
            this.dbPath = path.join(homeDir, '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
        }
    }

    /**
     * Decode varint from Buffer at given position.
     */
    private decodeVarint(data: Buffer, pos: number): { val: number; newPos: number } {
        let val = 0;
        let shift = 0;
        while (true) {
            if (pos >= data.length) {
                throw new Error('Varint decode out of bounds');
            }
            const b = data[pos];
            pos++;
            val |= (b & 0x7f) << shift;
            if (!(b & 0x80)) {
                break;
            }
            shift += 7;
        }
        return { val, newPos: pos };
    }

    /**
     * Encode number as varint Buffer.
     */
    private encodeVarint(val: number): Buffer {
        const res: number[] = [];
        while (true) {
            const b = val & 0x7f;
            val >>>= 7;
            if (val > 0) {
                res.push(b | 0x80);
            } else {
                res.push(b);
                break;
            }
        }
        return Buffer.from(res);
    }

    /**
     * Parse protobuf inner summary from Buffer.
     */
    private parseInnerSummary(innerBytes: Buffer): { title: string; createdAt: number } {
        let pos = 0;
        let title = '';
        let createdAt = 0;

        while (pos < innerBytes.length) {
            const decodedTag = this.decodeVarint(innerBytes, pos);
            const tag = decodedTag.val;
            pos = decodedTag.newPos;

            const fieldNum = tag >> 3;
            const wireType = tag & 0x07;

            if (wireType === 2) {
                const decodedLen = this.decodeVarint(innerBytes, pos);
                const length = decodedLen.val;
                pos = decodedLen.newPos;

                const val = innerBytes.subarray(pos, pos + length);
                pos += length;

                if (fieldNum === 1) {
                    title = val.toString('utf8');
                } else if (fieldNum === 3) {
                    try {
                        let subPos = 0;
                        const subTag = this.decodeVarint(val, subPos);
                        subPos = subTag.newPos;
                        const subVal = this.decodeVarint(val, subPos);
                        createdAt = subVal.val;
                    } catch (_) {}
                }
            } else {
                if (wireType === 0) {
                    const decodedVal = this.decodeVarint(innerBytes, pos);
                    pos = decodedVal.newPos;
                } else if (wireType === 1) {
                    pos += 8;
                } else if (wireType === 5) {
                    pos += 4;
                }
            }
        }
        return { title, createdAt };
    }

    /**
     * Serialize title and createdAt into inner summary protobuf buffer.
     */
    private serializeInnerSummary(title: string, createdAt: number): Buffer {
        const buffers: Buffer[] = [];

        const titleBytes = Buffer.from(title, 'utf8');
        buffers.push(this.encodeVarint((1 << 3) | 2));
        buffers.push(this.encodeVarint(titleBytes.length));
        buffers.push(titleBytes);

        if (createdAt > 0) {
            const subMsg = Buffer.concat([
                this.encodeVarint((1 << 3) | 0),
                this.encodeVarint(createdAt)
            ]);
            buffers.push(this.encodeVarint((3 << 3) | 2));
            buffers.push(this.encodeVarint(subMsg.length));
            buffers.push(subMsg);
        }

        return Buffer.concat(buffers);
    }

    /**
     * Parse state.vscdb trajectorySummaries blob.
     */
    private parseTrajectorySummaries(data: Buffer): Array<{ uuid: string; title: string; createdAt: number; rawBytes: Buffer }> {
        const items: Array<{ uuid: string; title: string; createdAt: number; rawBytes: Buffer }> = [];
        let pos = 0;

        while (pos < data.length) {
            try {
                const decodedTag = this.decodeVarint(data, pos);
                const tag = decodedTag.val;
                pos = decodedTag.newPos;

                const fieldNum = tag >> 3;
                const wireType = tag & 0x07;

                if (fieldNum === 1 && wireType === 2) {
                    const decodedLen = this.decodeVarint(data, pos);
                    const length = decodedLen.val;
                    pos = decodedLen.newPos;

                    const itemBytes = data.subarray(pos, pos + length);
                    pos += length;

                    let itemPos = 0;
                    let uuid = '';
                    let innerB64 = '';

                    while (itemPos < itemBytes.length) {
                        const decodedITag = this.decodeVarint(itemBytes, itemPos);
                        const itag = decodedITag.val;
                        itemPos = decodedITag.newPos;

                        const ifield = itag >> 3;
                        const iwire = itag & 0x07;

                        if (iwire === 2) {
                            const decodedILen = this.decodeVarint(itemBytes, itemPos);
                            const ilength = decodedILen.val;
                            itemPos = decodedILen.newPos;

                            const ival = itemBytes.subarray(itemPos, itemPos + ilength);
                            itemPos += ilength;

                            if (ifield === 1) {
                                uuid = ival.toString('utf8');
                            } else if (ifield === 2) {
                                let subPos = 0;
                                while (subPos < ival.length) {
                                    const decodedSubTag = this.decodeVarint(ival, subPos);
                                    const subTag = decodedSubTag.val;
                                    subPos = decodedSubTag.newPos;

                                    const subField = subTag >> 3;
                                    const subWire = subTag & 0x07;

                                    if (subField === 1 && subWire === 2) {
                                        const decodedSubLen = this.decodeVarint(ival, subPos);
                                        const subLen = decodedSubLen.val;
                                        subPos = decodedSubLen.newPos;

                                        const subVal = ival.subarray(subPos, subPos + subLen);
                                        subPos += subLen;

                                        innerB64 = subVal.toString('utf8');
                                    }
                                }
                            }
                        }
                    }

                    let title = '';
                    let createdAt = 0;
                    if (innerB64) {
                        try {
                            const innerBytes = Buffer.from(innerB64, 'base64');
                            const innerData = this.parseInnerSummary(innerBytes);
                            title = innerData.title;
                            createdAt = innerData.createdAt;
                        } catch (_) {}
                    }

                    items.push({
                        uuid,
                        title,
                        createdAt,
                        rawBytes: itemBytes
                    });
                }
            } catch (e) {
                // If parsing fails for a single record, log and break
                logger.warn(`[ChatDiskScannerService] Failed to parse trajectory item: ${e}`);
                break;
            }
        }
        return items;
    }

    /**
     * Serialize trajectory items back to protobuf format.
     */
    private serializeTrajectorySummaries(items: Array<{ rawBytes: Buffer }>): Buffer {
        const buffers: Buffer[] = [];
        for (const item of items) {
            buffers.push(this.encodeVarint((1 << 3) | 2));
            buffers.push(this.encodeVarint(item.rawBytes.length));
            buffers.push(item.rawBytes);
        }
        return Buffer.concat(buffers);
    }

    /**
     * Fetch active items list from IDE global state database.
     */
    private getActiveItemsFromDb(): Array<{ uuid: string; title: string; createdAt: number; rawBytes: Buffer }> {
        if (!fs.existsSync(this.dbPath)) {
            logger.info(`[ChatDiskScannerService] IDE DB not found at: ${this.dbPath}`);
            return [];
        }

        let db: Database.Database | null = null;
        try {
            db = new Database(this.dbPath, { readonly: true, timeout: 5000 });
            const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';");
            const row = stmt.get() as { value: string } | undefined;
            if (!row || !row.value) {
                return [];
            }
            const buf = Buffer.from(row.value, 'base64');
            return this.parseTrajectorySummaries(buf);
        } catch (e) {
            logger.error(`[ChatDiskScannerService] Error reading trajectory summaries from DB: ${e}`);
            return [];
        } finally {
            if (db) db.close();
        }
    }

    /**
     * Scan disk files recursively to get total size and file count.
     */
    private getFolderSizeAndCount(folderPath: string): { size: number; count: number } {
        let size = 0;
        let count = 0;

        if (!fs.existsSync(folderPath)) {
            return { size, count };
        }

        const stats = fs.statSync(folderPath);
        if (stats.isFile()) {
            return { size: stats.size, count: 1 };
        }

        try {
            const files = fs.readdirSync(folderPath);
            for (const file of files) {
                const fp = path.join(folderPath, file);
                const result = this.getFolderSizeAndCount(fp);
                size += result.size;
                count += result.count;
            }
        } catch (_) {}

        return { size, count };
    }

    /**
     * Try to extract heuristic chat title from transcript.jsonl or task.md.
     */
    private getHeuristicTitle(uuid: string): string {
        // Try reading transcript logs first
        const transcriptPath = path.join(this.brainDir, uuid, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(transcriptPath)) {
            try {
                const content = fs.readFileSync(transcriptPath, 'utf8');
                const lines = content.split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        if (data.type === 'USER_INPUT' && data.content) {
                            let text = data.content.trim();
                            // Strip <USER_REQUEST> tags
                            const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                            if (reqMatch) {
                                text = reqMatch[1].trim();
                            }
                            const textLines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);
                            if (textLines.length > 0) {
                                let title = textLines[0];
                                if (title.length > 60) {
                                    title = title.substring(0, 60) + '...';
                                }
                                return title;
                            }
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        }

        // Fallback to task.md
        const taskPath = path.join(this.brainDir, uuid, 'task.md');
        if (fs.existsSync(taskPath)) {
            try {
                const content = fs.readFileSync(taskPath, 'utf8');
                const firstLine = content.split('\n')[0].trim();
                if (firstLine.startsWith('#')) {
                    const title = firstLine.replace(/^#\s*/, '').trim();
                    if (title) return title;
                }
            } catch (_) {}
        }

        // Fallback to creation date
        const brainPath = path.join(this.brainDir, uuid);
        if (fs.existsSync(brainPath)) {
            try {
                const stats = fs.statSync(brainPath);
                return `Conversation (${stats.birthtime.toLocaleString('ru-RU')})`;
            } catch (_) {}
        }

        return `Unnamed Conversation (${uuid.substring(0, 8)})`;
    }

    /**
     * Format byte size into human-readable string.
     */
    private formatSize(bytes: number): string {
        if (bytes === 0) return '0 B';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    /**
     * Scan disk folders to gather full info on all chats.
     */
    public scanDiskChats(): DiskChatInfo[] {
        const activeItems = this.getActiveItemsFromDb();
        const activeUuids = new Set(activeItems.map(it => it.uuid.toLowerCase()));

        // Scan all UUID folders on disk
        const allUuids = new Set<string>();

        if (fs.existsSync(this.brainDir)) {
            try {
                const folders = fs.readdirSync(this.brainDir);
                for (const f of folders) {
                    if (fs.statSync(path.join(this.brainDir, f)).isDirectory() && f.length === 36) {
                        allUuids.add(f.toLowerCase());
                    }
                }
            } catch (_) {}
        }

        if (fs.existsSync(this.conversationsDir)) {
            try {
                const files = fs.readdirSync(this.conversationsDir);
                for (const file of files) {
                    const match = file.match(/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
                    if (match) {
                        allUuids.add(match[1].toLowerCase());
                    }
                }
            } catch (_) {}
        }

        if (fs.existsSync(this.annotationsDir)) {
            try {
                const files = fs.readdirSync(this.annotationsDir);
                for (const file of files) {
                    const match = file.match(/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
                    if (match) {
                        allUuids.add(match[1].toLowerCase());
                    }
                }
            } catch (_) {}
        }

        const chats: DiskChatInfo[] = [];

        for (const uuid of allUuids) {
            const isActive = activeUuids.has(uuid);
            
            // Resolve title
            let title = '';
            let createdAt = 0;
            if (isActive) {
                const activeItem = activeItems.find(it => it.uuid.toLowerCase() === uuid);
                if (activeItem) {
                    title = activeItem.title;
                    createdAt = activeItem.createdAt;
                }
            }

            if (!title) {
                title = this.getHeuristicTitle(uuid);
            }

            // Resolve folder size and stats
            let sizeBytes = 0;
            let fileCount = 0;

            const brainPath = path.join(this.brainDir, uuid);
            if (fs.existsSync(brainPath)) {
                const res = this.getFolderSizeAndCount(brainPath);
                sizeBytes += res.size;
                fileCount += res.count;
                if (createdAt === 0) {
                    try { createdAt = Math.floor(fs.statSync(brainPath).birthtimeMs / 1000); } catch (_) {}
                }
            }

            if (fs.existsSync(this.conversationsDir)) {
                try {
                    const files = fs.readdirSync(this.conversationsDir);
                    for (const f of files) {
                        if (f.startsWith(uuid)) {
                            const fp = path.join(this.conversationsDir, f);
                            const stats = fs.statSync(fp);
                            sizeBytes += stats.size;
                            fileCount += 1;
                        }
                    }
                } catch (_) {}
            }

            if (fs.existsSync(this.annotationsDir)) {
                try {
                    const files = fs.readdirSync(this.annotationsDir);
                    for (const f of files) {
                        if (f.startsWith(uuid)) {
                            const fp = path.join(this.annotationsDir, f);
                            const stats = fs.statSync(fp);
                            sizeBytes += stats.size;
                            fileCount += 1;
                        }
                    }
                } catch (_) {}
            }

            const createdAtStr = createdAt > 0
                ? new Date(createdAt * 1000).toLocaleString('ru-RU')
                : 'Неизвестно';

            chats.push({
                uuid,
                title,
                isActive,
                sizeBytes,
                sizeStr: this.formatSize(sizeBytes),
                fileCount,
                createdAt,
                createdAtStr
            });
        }

        return chats;
    }

    /**
     * Delete files associated with a chat UUID from the disk.
     * Performs lock pre-flight check and throws if files are locked.
     */
    public deleteChatFiles(uuid: string): { success: boolean; freedBytes: number; error?: string } {
        const uuidLower = uuid.toLowerCase();

        // 1. Lock check
        const lockedFiles: string[] = [];
        const brainPath = path.join(this.brainDir, uuidLower);
        const convFiles: string[] = [];
        const annotFiles: string[] = [];

        if (fs.existsSync(brainPath)) {
            try {
                const tempPath = brainPath + '.lock_test';
                fs.renameSync(brainPath, tempPath);
                fs.renameSync(tempPath, brainPath);
            } catch (e: any) {
                lockedFiles.push(`brain/${uuidLower} (${e.message})`);
            }
        }

        if (fs.existsSync(this.conversationsDir)) {
            try {
                const files = fs.readdirSync(this.conversationsDir);
                for (const f of files) {
                    if (f.startsWith(uuidLower)) {
                        const fp = path.join(this.conversationsDir, f);
                        convFiles.push(fp);
                        try {
                            const tempFp = fp + '.lock_test';
                            fs.renameSync(fp, tempFp);
                            fs.renameSync(tempFp, fp);
                        } catch (e: any) {
                            lockedFiles.push(`conversations/${f} (${e.message})`);
                        }
                    }
                }
            } catch (_) {}
        }

        if (fs.existsSync(this.annotationsDir)) {
            try {
                const files = fs.readdirSync(this.annotationsDir);
                for (const f of files) {
                    if (f.startsWith(uuidLower)) {
                        const fp = path.join(this.annotationsDir, f);
                        annotFiles.push(fp);
                        try {
                            const tempFp = fp + '.lock_test';
                            fs.renameSync(fp, tempFp);
                            fs.renameSync(tempFp, fp);
                        } catch (e: any) {
                            lockedFiles.push(`annotations/${f} (${e.message})`);
                        }
                    }
                }
            } catch (_) {}
        }

        if (lockedFiles.length > 0) {
            return {
                success: false,
                freedBytes: 0,
                error: `Некоторые файлы заблокированы IDE: ${lockedFiles.join(', ')}. Перезагрузите окно IDE (Ctrl+R) и попробуйте снова.`
            };
        }

        // 2. Perform deletion
        let freedBytes = 0;

        // Delete brain folder
        if (fs.existsSync(brainPath)) {
            try {
                const sizeResult = this.getFolderSizeAndCount(brainPath);
                fs.rmSync(brainPath, { recursive: true, force: true });
                freedBytes += sizeResult.size;
            } catch (e: any) {
                logger.error(`[ChatDiskScannerService] Failed to delete brain folder: ${e.message}`);
            }
        }

        // Delete conversations
        for (const fp of convFiles) {
            try {
                if (fs.existsSync(fp)) {
                    freedBytes += fs.statSync(fp).size;
                    fs.unlinkSync(fp);
                }
            } catch (e: any) {
                logger.error(`[ChatDiskScannerService] Failed to delete conversation file: ${e.message}`);
            }
        }

        // Delete annotations
        for (const fp of annotFiles) {
            try {
                if (fs.existsSync(fp)) {
                    freedBytes += fs.statSync(fp).size;
                    fs.unlinkSync(fp);
                }
            } catch (e: any) {
                logger.error(`[ChatDiskScannerService] Failed to delete annotation file: ${e.message}`);
            }
        }

        // 3. Remove from state.vscdb trajectorySummaries index if active
        if (fs.existsSync(this.dbPath)) {
            let db: Database.Database | null = null;
            try {
                db = new Database(this.dbPath, { timeout: 5000 });
                const stmtGet = db.prepare("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';");
                const row = stmtGet.get() as { value: string } | undefined;
                if (row && row.value) {
                    const buf = Buffer.from(row.value, 'base64');
                    const activeItems = this.parseTrajectorySummaries(buf);
                    const filteredItems = activeItems.filter(it => it.uuid.toLowerCase() !== uuidLower);
                    
                    if (activeItems.length !== filteredItems.length) {
                        const newBuf = this.serializeTrajectorySummaries(filteredItems);
                        const newB64 = newBuf.toString('base64');
                        const stmtUpdate = db.prepare("UPDATE ItemTable SET value = ? WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';");
                        stmtUpdate.run(newB64);
                        logger.info(`[ChatDiskScannerService] Removed ${uuidLower} from IDE DB trajectorySummaries`);
                    }
                }
            } catch (e: any) {
                logger.error(`[ChatDiskScannerService] Failed to remove chat from state.vscdb: ${e.message}`);
            } finally {
                if (db) db.close();
            }
        }

        return {
            success: true,
            freedBytes
        };
    }
}
