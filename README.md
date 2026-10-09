# Мультиплеер «Посёлок у реки» — мини-сервер

Сервер без WebSocket: обычные HTTP/JSON-запросы. Клиент (тот же `index.html`)
обращается к нему только в режиме мультиплеера. Одиночная игра работает как
раньше и сервер не использует.

## Хранилище: два режима

| Режим | Когда | Данные |
|---|---|---|
| **Постоянная БД (рекомендуется)** | задана переменная `DATABASE_URL` (Neon/Supabase Postgres) | **не теряются** при перезапуске Render |
| Временный `data.json` | `DATABASE_URL` не задана | теряются при каждом рестарте/деплое Render |

Сервер сам выбирает режим: если есть `DATABASE_URL` — работает с Postgres
(таблицы создаются автоматически), иначе пишет в `data.json`. Логика игры
(`index.html`) от этого не зависит — API одинаковый.

## Файлы

| Файл | Назначение |
|---|---|
| `server.js` | сервер: аккаунты, сохранения, участки, `/api/village` |
| `package.json` | описание проекта, команда `npm start`, зависимость `pg` |
| `data.json` | временная база (только если нет `DATABASE_URL`) |

## Быстрый локальный запуск (временный режим)

1. Установить **Node.js LTS** с <https://nodejs.org>.
2. В этой папке (`online`) открыть PowerShell, выполнить:
   ```
   node server.js
   ```
   Появится `Riverside Village server on http://localhost:3000`.
3. Открыть в браузере <http://localhost:3000>, нажать **Multiplayer**.
   Внизу экрана будет написано `Сервер: http://localhost:3000`.

> Если PowerShell не даёт запускать `npm` («выполнение сценариев отключено»),
> используйте `npm.cmd` вместо `npm` или один раз разрешите:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`.

## Постоянная БД (Neon — бесплатно)

1. Зарегистрироваться на <https://neon.com> (можно через GitHub/Google).
2. Создать **Project** (регион — ближе к вам, напр. Frankfurt).
3. В панели проекта нажать **Connect** и скопировать строку вида
   `postgresql://user:пароль@host/db?sslmode=require`.
4. **Локально проверить** (в папке `online`):
   ```
   npm.cmd install pg
   $env:DATABASE_URL="СЮДА_ВСТАВИТЬ_СТРОКУ"
   node server.js
   ```
   Должно появиться `Storage: PostgreSQL (persistent)`. Таблицы создаются сами.
5. Зайти в игру и проверить, что вход/сохранение работает.

> Строка подключения содержит пароль — никому её не показывайте и не коммитьте
> в Git. В Render она задаётся только через переменные окружения.

## Выложить в интернет (Render)

1. Зарегистрироваться на <https://render.com> (через GitHub).
2. Положить папку игры (или весь проект) в репозиторий на GitHub.
3. В Render: **New → Web Service** → подключить репозиторий.
4. Настройки:
   - **Root Directory**: `online`;
   - **Build Command**: `npm install`;
   - **Start Command**: `npm start`;
   - **Instance Type**: Free.
5. **Environment → Add Environment Variable**:
   - Key: `DATABASE_URL`, Value: строка из Neon (шаг 3 выше).
6. Дождаться адреса `https://имя.onrender.com`.
7. Вписать этот адрес в игру в константу `MP_SERVER_URL` (в `index.html`).

После этого данные живут в Neon и не пропадают при «засыпании» Render.

## Про бесплатный Render

Даже с постоянной БД сам Render-сервис **засыпает** после ~15 минут без
запросов и просыпается на 30–60 с при первом обращении. Это нормально: данные
в Neon при этом целы, страдает только скорость первого захода.

## Проверка API вручную

```
curl http://localhost:3000/api/village
curl -X POST http://localhost:3000/api/register -H "Content-Type: application/json" -d "{\"login\":\"tester\",\"password\":\"1234\"}"
```

На свежей базе `/api/village` вернёт `[]`.
