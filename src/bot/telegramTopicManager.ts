import { Api } from 'grammy';
import { logger } from '../utils/logger';

export interface EnsureTopicResult {
    topicId: number;
    created: boolean;
}

/**
 * Manages Telegram Forum Topics for workspace isolation.
 * Each workspace gets its own topic in a forum-enabled supergroup.
 */
export class TelegramTopicManager {
    private chatId: number | string;
    private readonly api: Api;
    private topicCache: Map<string, number> = new Map();

    constructor(api: Api, chatId: number | string) {
        this.api = api;
        this.chatId = chatId;
    }

    /**
     * Ensure a forum topic exists for the given workspace name.
     * Creates a new topic if it doesn't exist; returns existing topic_id otherwise.
     */
    public async ensureTopic(workspaceName: string): Promise<EnsureTopicResult> {
        const cached = this.topicCache.get(workspaceName);
        if (cached) return { topicId: cached, created: false };

        try {
            const topic = await this.api.createForumTopic(this.chatId, `🗂️ ${workspaceName}`);
            this.topicCache.set(workspaceName, topic.message_thread_id);
            return { topicId: topic.message_thread_id, created: true };
        } catch (error: any) {
            logger.error(`[TopicManager] Failed to create topic for "${workspaceName}":`, error?.message || error);
            throw error;
        }
    }

    /**
     * Create a session topic under a workspace context.
     */
    public async createSessionTopic(sessionName: string): Promise<number> {
        try {
            const topic = await this.api.createForumTopic(this.chatId, `💬 ${sessionName}`);
            return topic.message_thread_id;
        } catch (error: any) {
            logger.error(`[TopicManager] Failed to create session topic "${sessionName}":`, error?.message || error);
            throw error;
        }
    }

    /**
     * Rename a forum topic.
     */
    public async renameTopic(topicId: number, newName: string): Promise<void> {
        try {
            await this.api.editForumTopic(this.chatId, topicId, { name: newName });
        } catch (error: any) {
            logger.error(`[TopicManager] Failed to rename topic ${topicId}:`, error?.message || error);
        }
    }

    /**
     * Close (archive) a forum topic.
     */
    public async closeTopic(topicId: number): Promise<void> {
        try {
            await this.api.closeForumTopic(this.chatId, topicId);
        } catch (error: any) {
            logger.error(`[TopicManager] Failed to close topic ${topicId}:`, error?.message || error);
        }
    }

    /**
     * Delete a forum topic.
     */
    public async deleteTopic(topicId: number): Promise<void> {
        try {
            await this.api.deleteForumTopic(this.chatId, topicId);
        } catch (error: any) {
            logger.error(`[TopicManager] Failed to delete topic ${topicId}:`, error?.message || error);
        }
    }

    public setChatId(chatId: number | string): void {
        this.chatId = chatId;
    }

    public registerTopic(workspaceName: string, topicId: number): void {
        this.topicCache.set(workspaceName, topicId);
    }

    public getTopicId(workspaceName: string): number | undefined {
        return this.topicCache.get(workspaceName);
    }

    public sanitizeName(name: string): string {
        let sanitized = name
            .replace(/\/+$/, '')
            .replace(/\//g, '-')
            .replace(/-{2,}/g, '-')
            .replace(/^-+|-+$/g, '');

        if (sanitized.length > 128) {
            sanitized = sanitized.substring(0, 128);
        }

        return sanitized;
    }
}
