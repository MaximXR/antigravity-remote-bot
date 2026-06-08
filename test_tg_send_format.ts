import { htmlToTelegramHtml } from './src/utils/htmlToTelegramMarkdown';
import { Bot, InlineKeyboard } from 'grammy';
import * as https from 'https';
// @ts-ignore
import fetch from 'node-fetch';
import { loadConfig } from './src/utils/config';

async function test() {
    const config = loadConfig();
    const token = config.telegramBotToken;
    const chatId = "568489667"; // allowed user ID from DB

    const agentOutput = `Так как вы с телефона, вот краткая выжимка того, что я планирую сделать:

1. Автоподтверждение Undo:
На скриншоте видно, что при клике «Отменить» IDE выводит окно подтверждения Confirm Undo. Я сделаю так, чтобы бот автоматически кликал Confirm в этом окне через 300 мс после отката, чтобы всё происходило по одной кнопке в Telegram.

2. Воркспейсы и Проекты:

- Сейчас кнопка «Проекты» выводит папки в вашей базовой директории (например, C:\\Users\\sss77\\Code).

- Я научу бота искать в этих папках файлы .code-workspace и открывать их как полноценные мульти-рутовые воркспейсы.

- Добавлю команду /setworkspacedir <path>, чтобы вы могли менять базовую папку проектов прямо с телефона.

3. Трансляция чата из IDE в Telegram:

- Бот начнет слушать чат в самой IDE на компьютере.

- Если вы напишете промпт прямо в IDE, бот перешлет его в Telegram с пометкой 👤 [IDE]: <текст>.

- Бот автоматически включит трансляцию ответа Агента в Telegram, чтобы вы могли следить за генерацией с телефона в реальном времени.

Если вы согласны с этим планом, дайте знать, и я приступлю к реализации!`;

    // 1. Format using htmlToTelegramHtml (or formatForTelegram)
    const formattedHtml = htmlToTelegramHtml(agentOutput);
    console.log("--- Formatted HTML ---");
    console.log(formattedHtml);
    console.log("----------------------");

    // Let's configure Grammy
    const fallbackIpsRaw = process.env.TELEGRAM_FALLBACK_IPS || '149.154.167.220';
    const fallbackIps = fallbackIpsRaw.split(',').map(ip => ip.trim()).filter(Boolean);
    let botConfig: any = {};
    if (fallbackIps.length > 0) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const agent = new https.Agent({
            keepAlive: true,
            rejectUnauthorized: false,
            servername: 'api.telegram.org',
        });
        const customFetch = (url: any, init: any) => {
            const headers = {
                ...(init?.headers || {}),
                'Host': 'api.telegram.org',
            };
            return fetch(url, {
                ...init,
                agent,
                headers,
            });
        };
        botConfig = {
            client: {
                apiRoot: `https://${fallbackIps[0]}`,
                fetch: customFetch as any,
            },
        };
    }

    const bot = new Bot(token, botConfig);
    const undoKeyboard = new InlineKeyboard().text('↩️ Отменить', 'undo_last');

    try {
        console.log("Sending formatted HTML to Telegram...");
        const res = await bot.api.sendMessage(chatId, formattedHtml, {
            parse_mode: 'HTML',
            reply_markup: undoKeyboard
        });
        console.log("SUCCESS! Message ID:", res.message_id);
    } catch (e: any) {
        console.error("FAILED to send:", e.message || e);
        if (e.description) {
            console.error("Telegram description:", e.description);
        }
    }
}

test();
