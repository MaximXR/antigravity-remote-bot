export interface AbstractButton {
    text: string;
    action: string; // Например, 'approve', 'deny', 'undo_last' или специфичные данные callback_query
}

export interface ChannelContext {
    chatId: number;
    threadId?: number;
}

export interface IMessengerPort {
    sendMessage(channel: ChannelContext, text: string, buttons?: AbstractButton[] | AbstractButton[][]): Promise<number | null>;
    editMessage(channel: ChannelContext, messageId: number, text: string, buttons?: AbstractButton[] | AbstractButton[][]): Promise<void>;
    sendDocument(channel: ChannelContext, buffer: Buffer, filename: string, caption?: string, buttons?: AbstractButton[] | AbstractButton[][]): Promise<void>;
    sendPhoto(channel: ChannelContext, buffer: Buffer, filename: string, caption?: string): Promise<void>;
    renameChannelTopic?(channel: ChannelContext, newName: string): Promise<void>;
    cleanMessageButtons?(channel: ChannelContext, messageId: number): Promise<void>;
}
