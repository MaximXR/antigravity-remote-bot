---
trigger: manual
description: "ТРИГГЕР: Правила разработки Remoat, структура БД, CDP селекторы, команды сборки, запуска и отладки."
---

# Системные правила разработки Remoat для ИИ

## 1. База Данных SQLite

Бот использует БД SQLite (по умолчанию файл расположен в `C:\Users\sss77\.remoat\remoat.db`).

### Схема таблиц

```sql
-- Таблица workspace_bindings (привязка каналов Telegram к проектам IDE)
CREATE TABLE IF NOT EXISTS workspace_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL UNIQUE, -- Идентификатор канала (chatId:threadId или просто chatId)
    workspace_path TEXT NOT NULL,   -- Относительный или полный путь к проекту
    guild_id TEXT NOT NULL,         -- ID сервера Telegram
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Таблица chat_sessions (сопоставление топиков Telegram и сессий чата в IDE)
CREATE TABLE IF NOT EXISTS chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL UNIQUE,     -- ID канала
    category_id TEXT NOT NULL,           -- ID категории проекта
    workspace_path TEXT NOT NULL,        -- Путь к проекту
    session_number INTEGER NOT NULL,     -- Порядковый номер сессии в категории
    display_name TEXT,                   -- Название сессии в IDE
    is_renamed INTEGER NOT NULL DEFAULT 0, -- Флаг переименования (1 - переименовано)
    guild_id TEXT NOT NULL,              -- ID сервера Telegram
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Таблица templates (шаблоны промптов)
CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,           -- Название шаблона
    prompt TEXT NOT NULL,                -- Текст промпта
    category TEXT                        -- Категория
);
```

## 2. CDP Селекторы (Antigravity IDE)

Все взаимодействия с IDE происходят через Chrome DevTools Protocol (CDP) WebSocket.

| Элемент | Селектор / Скрипт | Метод клика |
| :--- | :--- | :--- |
| **Поле ввода (Chat Input)** | `div[role="textbox"]:not(.xterm-helper-textarea), div[role="combobox"]:not(.xterm-helper-textarea)` | Фокус + `Runtime.evaluate` / `Input.dispatchKeyEvent` |
| **Кнопка отправки** | `button` содержащий SVG с классами `lucide-arrow-right`, `lucide-arrow-up`, `lucide-send` | CDP Mouse Click по координатам `getBoundingClientRect()` |
| **Кнопка отмены (Stop)** | `button` с title/aria-label/class содержащим `stop` или `stop-generation` | CDP Mouse Click по координатам `getBoundingClientRect()` |
| **Кнопка Undo (Откат)** | `button[data-testid="revert-button"], [role="button"][data-testid="revert-button"]` | Скроллинг на центр экрана + CDP Mouse Click по координатам + подтверждение клавишей `Enter` через CDP |
| **Кнопка "New Chat"** | `[data-tooltip-id="new-conversation-tooltip"]` | CDP Mouse Click, если курсор имеет стиль `pointer` |
| **История (Past Conversations)** | `[data-past-conversations-toggle]` или с `data-tooltip-id` содержащим `history` | CDP Mouse Click, закрытие кнопкой `Escape` |

### Логика сопоставления сессий (Нечеткий поиск)
Сессии в списке IDE могут усекаться (например, `Название длинного промпта...`). При поиске сессии по имени:
- Сравнивать первые 20–25 символов без учета регистра.
- Проверять взаимное вхождение: `wanted.includes(itemTitle)` или `itemTitle.includes(wanted)`.

## 3. Разработка, Сборка и Запуск

### Компиляция TypeScript
```powershell
# Сборка проекта
npm run build
# Или напрямую через tsc
npx tsc
```

### Запуск бота
Бот запускается в фоновом режиме. Файл блокировки процесса находится по пути: `C:\Users\sss77\.remoat\.bot.lock`.
```powershell
# Запуск в режиме разработки
npm run dev
```

### Перезапуск фонового бота
ЕСЛИ нужно перезапустить бота -> ТО:
1. Завершить процесс по PID из файла блокировки или найти процесс Node.js, удерживающий порт / файлы.
2. Удалить файл блокировки `C:\Users\sss77\.remoat\.bot.lock` (если остался).
3. Запустить бота заново в фоне.

### Порты отладки IDE
IDE запускается с открытым портом отладки. По умолчанию сканируются порты `9333`, `9223` и `9222`.
Убедиться в доступности порта перед подключением:
```powershell
# Проверка открытого порта
Test-NetConnection -Port 9333 -ComputerName localhost
```