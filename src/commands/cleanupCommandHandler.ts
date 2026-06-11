import { ChatSessionRepository, ChatSessionRecord } from '../database/chatSessionRepository';
import { WorkspaceBindingRepository, WorkspaceBindingRecord } from '../database/workspaceBindingRepository';
import { ChatDiskScannerService, DiskChatInfo } from '../services/chatDiskScannerService';

export const CLEANUP_ARCHIVE_BTN = 'cleanup_archive';
export const CLEANUP_DELETE_BTN = 'cleanup_delete';
export const CLEANUP_CANCEL_BTN = 'cleanup_cancel';

// Callback buttons for disk cleanup
export const CLEANUP_DISK_ORPHANED_BTN = 'cleanup_disk_orphaned';
export const CLEANUP_DISK_ALL_INACTIVE_BTN = 'cleanup_disk_all_inactive';

export interface InactiveSession {
    binding: WorkspaceBindingRecord;
    session: ChatSessionRecord | undefined;
}

export interface DiskCleanupResult {
    processedCount: number;
    freedBytes: number;
    errors: string[];
}

/**
 * Cleanup handler.
 * In Telegram mode, cleanup of topics is handled in the main bot via Forum Topic API.
 * This class retains DB cleanup utilities.
 */
export class CleanupCommandHandler {
    private readonly chatSessionRepo: ChatSessionRepository;
    private readonly bindingRepo: WorkspaceBindingRepository;
    private readonly diskScanner: ChatDiskScannerService;

    constructor(
        chatSessionRepo: ChatSessionRepository,
        bindingRepo: WorkspaceBindingRepository,
    ) {
        this.chatSessionRepo = chatSessionRepo;
        this.bindingRepo = bindingRepo;
        this.diskScanner = new ChatDiskScannerService();
    }

    public cleanupByChannelId(channelId: string): void {
        this.chatSessionRepo.deleteByChannelId(channelId);
        this.bindingRepo.deleteByChannelId(channelId);
    }

    public findInactiveSessions(guildId: string, days: number): InactiveSession[] {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffIso = cutoff.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

        const bindings = this.bindingRepo.findByGuildId(guildId);
        const inactive: InactiveSession[] = [];

        for (const binding of bindings) {
            const session = this.chatSessionRepo.findByChannelId(binding.channelId);
            const createdAt = session?.createdAt ?? binding.createdAt;
            if (createdAt && createdAt < cutoffIso) {
                inactive.push({ binding, session });
            }
        }

        return inactive;
    }

    /**
     * Get disk usage statistics for active and orphaned chats.
     */
    public getDiskStats() {
        const chats = this.diskScanner.scanDiskChats();
        
        let totalSizeBytes = 0;
        let totalCount = 0;
        let orphanedSizeBytes = 0;
        let orphanedCount = 0;
        const orphanedChats: DiskChatInfo[] = [];

        for (const chat of chats) {
            totalSizeBytes += chat.sizeBytes;
            totalCount++;

            if (!chat.isActive) {
                orphanedSizeBytes += chat.sizeBytes;
                orphanedCount++;
                orphanedChats.push(chat);
            }
        }

        return {
            totalSizeBytes,
            totalCount,
            orphanedSizeBytes,
            orphanedCount,
            orphanedChats,
            allDiskChats: chats
        };
    }

    /**
     * Clean up files of a specific chat UUID on disk.
     */
    public deleteChatFiles(uuid: string) {
        return this.diskScanner.deleteChatFiles(uuid);
    }

    /**
     * Clean up all orphaned (not active in IDE) chat files on disk.
     */
    public cleanupOrphanedChats(): DiskCleanupResult {
        const stats = this.getDiskStats();
        let processedCount = 0;
        let freedBytes = 0;
        const errors: string[] = [];

        for (const chat of stats.orphanedChats) {
            const res = this.diskScanner.deleteChatFiles(chat.uuid);
            if (res.success) {
                processedCount++;
                freedBytes += res.freedBytes;
            } else if (res.error) {
                errors.push(`${chat.uuid.substring(0, 8)}: ${res.error}`);
            }
        }

        return {
            processedCount,
            freedBytes,
            errors
        };
    }

    /**
     * Clean up files of all inactive (or orphaned) chats on disk.
     */
    public cleanupAllInactiveChats(): DiskCleanupResult {
        const chats = this.diskScanner.scanDiskChats();
        let processedCount = 0;
        let freedBytes = 0;
        const errors: string[] = [];

        for (const chat of chats) {
            if (!chat.isActive) {
                const res = this.diskScanner.deleteChatFiles(chat.uuid);
                if (res.success) {
                    processedCount++;
                    freedBytes += res.freedBytes;
                } else if (res.error) {
                    errors.push(`${chat.uuid.substring(0, 8)}: ${res.error}`);
                }
            }
        }

        return {
            processedCount,
            freedBytes,
            errors
        };
    }
}
