# BevHubAI

Генерация рекламных вертикальных видео (MP4 1080×1920, 15 с) из фото товара и описания: сценарий, субтитры, озвучка.

## Требования

- Node.js **22.13+** (используется встроенный `node:sqlite`)
- FFmpeg ставить не нужно — используется бинарник из npm
- Шрифт с кириллицей для субтитров находится автоматически (Windows: Arial, Linux: DejaVu Sans), иначе задайте `SUBTITLE_FONT`

## Запуск

```bash
npm install
npm run start-server   # backend: http://localhost:3001 (API, база, генерация)
npm run dev            # frontend: http://localhost:5173 (проксирует /api на backend)
```

Откройте http://localhost:5173, зарегистрируйтесь и создайте видео.

## Как устроено

- **Frontend** — React + Vite (`src/`). Общается только с собственным API (`src/lib/api.ts`).
- **Backend** — Express (`server.js`, `server/`):
  - `server/db.js` — SQLite база `data/bevhub.db` (создаётся автоматически)
  - `server/auth.js` — регистрация/вход, пароли scrypt, сессия в HttpOnly cookie
  - `server/generation.js` — очередь генерации; состояние хранится в базе, поэтому обновление страницы не запускает повторный рендер, а прерванные перезапуском задачи помечаются как failed
  - `server/media.js` — сценарий (OpenAI или шаблоны), Google TTS, FFmpeg
- **Файлы** — `uploads/images` и `uploads/videos`, отдаются только владельцу через `/api/files/:id` и `/api/videos/:id/file`.

## Работа без ключей

Проект полностью работает без API-ключей и подписок:

- **Сценарий** — встроенный генератор BevHub Engine (разные варианты на каждый запрос). С ключом OpenAI сценарии пишет OpenAI.
- **Озвучка** — онлайн-голос при наличии интернета, иначе офлайн-голоса Windows (Irina — русский, Zira/David — английский женский/мужской). Для показа без интернета задайте `TTS_PROVIDER=local`.
- **Видео и субтитры** — локальный FFmpeg.

## Переменные окружения

Все опциональны, см. `.env.example`. `OPENAI_API_KEY` используется только на сервере.

## Проверки

```bash
npm run typecheck
npm run lint
npm run build
```
