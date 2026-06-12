import { escapeHtml } from '../utils/telegramFormatter';
import type { QuestionInfo } from '../services/questionDetector';
import type { AbstractButton } from '../services/messengerPort';

export interface QuestionNotificationUI {
    text: string;
    buttons: AbstractButton[][];
}

/**
 * Форматирует интерактивный вопрос для Telegram.
 * Варианты ответов выводятся в тексте сообщения с номерами,
 * а клавиатура содержит кнопки с цифрами (для обычных вариантов).
 * Кнопка Skip добавляется всегда.
 */
export function buildQuestionNotificationUI(
    info: QuestionInfo,
    projectName: string,
    targetChannelStr: string,
    buildAnswerCustomId: (optionIndex: number, projectName: string, channelId?: string) => string,
    buildSkipCustomId: (projectName: string, channelId?: string) => string,
): QuestionNotificationUI {
    let text = `❓ <b>Требуется ответ на вопрос</b>\n\n`;
    text += `<b>Вопрос:</b> ${escapeHtml(info.question)}\n\n`;
    text += `<b>Варианты:</b>\n`;
    
    info.options.forEach((opt, index) => {
        text += `${index + 1}. ${escapeHtml(opt)}\n`;
    });
    
    text += `\n<b>Рабочая область:</b> ${escapeHtml(projectName)}`;

    const buttons: AbstractButton[][] = [];
    const optionButtons: AbstractButton[] = [];

    info.options.forEach((opt, index) => {
        optionButtons.push({
            text: `${index + 1}`,
            action: buildAnswerCustomId(index, projectName, targetChannelStr),
        });
    });

    // Группируем кнопки по 4 в ряд
    const chunkedOptions: AbstractButton[][] = [];
    for (let i = 0; i < optionButtons.length; i += 4) {
        chunkedOptions.push(optionButtons.slice(i, i + 4));
    }
    buttons.push(...chunkedOptions);

    // Добавляем кнопку пропуска
    buttons.push([{
        text: `⏭ Пропустить (Skip)`,
        action: buildSkipCustomId(projectName, targetChannelStr),
    }]);

    return { text, buttons };
}
