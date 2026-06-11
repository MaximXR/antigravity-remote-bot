# Схема Базы Данных SQLite

Бот использует БД SQLite для хранения привязок проектов, сессий чата, шаблонов промптов и расписаний.

## Расположение БД
По умолчанию файл базы данных находится по пути:
`C:\Users\sss77\.remoat\remoat.db` (или `antigravity.db` в зависимости от конфигурации).

## Схема Таблиц

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
    channel_id TEXT NOT NULL UNIQUE,     -- ID канала (chatId:threadId)
    category_id TEXT NOT NULL,           -- ID категории проекта в IDE
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

-- Таблица schedules (задачи по расписанию)
CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cron_expression TEXT NOT NULL,       -- Cron выражение
    prompt TEXT NOT NULL,                -- Содержимое промпта
    workspace_path TEXT NOT NULL,        -- Путь к проекту
    channel_id TEXT NOT NULL,            -- ID канала для отправки результатов
    status TEXT NOT NULL DEFAULT 'active', -- Статус задачи (active/paused)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```
