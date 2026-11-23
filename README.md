# BevHubAI

Генерация рекламных вертикальных видео (MP4 1080×1920, 15 с) из фото товара и описания: сценарий, субтитры, озвучка.

## Требования

- Node.js **22.13+** (используется встроенный `node:sqlite`)
- FFmpeg ставить не нужно — используется бинарник из npm
- Шрифт с кириллицей для субтитров находится автоматически (Windows: Arial, Linux: DejaVu Sans), иначе задайте `SUBTITLE_FONT`
- Опционально: Python 3 + `edge-tts` — для бесплатных голосов Microsoft, включая узбекские

## Запуск (локально)

```bash
npm install
npm run start-server   # backend: http://localhost:3001 (API, база, генерация)
npm run dev            # frontend: http://localhost:5173 (проксирует /api на backend)
```

Откройте http://localhost:5173, зарегистрируйтесь и создайте видео.

## Быстрое видео

На странице **/quick** введите одно текстовое описание рекламы — сервер сам определит язык, тип рекламы (товар, недвижимость, еда, работа и т.д.) и стиль, напишет сценарий, озвучит его и соберёт 15-секундное вертикальное видео с градиентным фоном, субтитрами и (если задано) ценой + ссылкой на сайт. Фото не нужны.

## Как устроено

- **Frontend** — React + Vite (`src/`). Общается только с собственным API (`src/lib/api.ts`).
- **Backend** — Express (`server.js`, `server/`):
  - `server/db.js` — SQLite база `data/bevhub.db` (создаётся автоматически), WAL, ночной бэкап в `data/backups`
  - `server/auth.js` — регистрация/вход, пароли scrypt, сессия в HttpOnly cookie
  - `server/generation.js` — очередь генерации; состояние хранится в базе, поэтому обновление страницы не запускает повторный рендер, а прерванные перезапуском задачи помечаются как failed
  - `server/ai/` — AI-сценарии (Nemotron через OpenRouter, OpenAI-совместимые провайдеры, Ollama)
  - `server/tts/` — озвучка: Edge Neural (в т.ч. узбекский), Google TTS, Windows SAPI
  - `server/media.js` — FFmpeg, субтитры, сборка видео
- **Файлы** — `uploads/images` и `uploads/videos`, отдаются только владельцу через `/api/files/:id` и `/api/videos/:id/file`.

## Работа без ключей

Проект полностью работает без API-ключей и подписок:

- **Сценарий** — встроенный генератор BevHub Engine (разные варианты на каждый запрос). С ключом OpenRouter, OpenAI или при доступной Ollama сценарии пишет AI, и в интерфейсе это всегда подписано как AI.
- **Озвучка** — по умолчанию голос Edge Neural (нужен Python + `edge-tts`, см. ниже), иначе Google TTS, иначе офлайн-голоса Windows (Irina — русский, Zira/David — английский).
- **Видео и субтитры** — локальный FFmpeg.

## Переменные окружения

Все переменные описаны в `.env.example`. Ключи AI-провайдеров (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `CUSTOM_AI_API_KEY`) используются только на сервере и никогда не попадают во frontend bundle. Для OpenRouter задайте `OPENROUTER_API_KEY`; `OPENROUTER_MODEL` по умолчанию равен `nvidia/nemotron-3-ultra-550b-a55b:free`, а `OPENROUTER_IMAGE_MODEL` — `openai/gpt-image-2` для генерации изображений. Ошибка настроенного OpenRouter возвращается клиенту и не переключает запрос на другую модель.

---

# Развёртывание (production)

## 1. Требования к серверу

| Компонент | Минимум | Примечание |
|---|---|---|
| ОС | Linux (systemd) или Windows Server | проверено на Windows 11 / Node 24 |
| Node.js | **22.13+** | обязателен встроенный `node:sqlite`; 22.x и 24.x подходят |
| CPU / RAM | 2 vCPU / 2 ГБ | рендер 15-секундного видео на 2 параллельных задачах |
| Диск | 10 ГБ | база, загруженные фото, готовые MP4 (~1 МБ на видео), бэкапы |
| FFmpeg | не требуется | бинарники в `@ffmpeg-installer/ffmpeg` и `@ffprobe-installer/ffprobe` |
| Python 3 | 3.10+ | только для бесплатного Edge TTS (узбекский, русский, английский) |
| Браузер | — | frontend статический, раздаётся reverse proxy |

Один процесс Node.js: API, очередь рендера и фоновые задачи (бэкап, уборка) живут в одном процессе. Для нескольких инстансов нужна внешняя БД и очередь — см. «Ограничения SQLite».

## 2. Установка Node.js 22.13+

```bash
# проверка версии — должно быть v22.13.0 или новее
node --version

# Ubuntu/Debian (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Windows: установщик LTS с https://nodejs.org (winget install OpenJS.NodeJS.LTS)
```

Приложение отказывается стартовать на `node:sqlite` из более старых версий, поэтому версию нужно проверить до развёртывания.

## 3. Установка зависимостей

```bash
npm ci                # строго по package-lock.json, без dev-коллизий
```

`npm ci` (а не `npm install`) даёт воспроизводимую установку на сервере. Все зависимости из `dependencies` — рантаймовые и нужны в production: `express`, `multer`, `cors`, `dotenv`, `fluent-ffmpeg`, `google-tts-api` (озвучка Google), `@ffmpeg-installer/ffmpeg` и `@ffprobe-installer/ffprobe` (бинарники), `react`/`react-dom`/`react-router-dom`/`lucide-react` (сборка frontend). Dev-зависимости нужны только для `typecheck`, `lint` и `build` — их можно не устанавливать на сервере (`npm ci --omit=dev` сломает `build`, поэтому сборку делайте до этого шага или на отдельной машине).

## 4. Настройка `.env`

```bash
cp .env.example .env
nano .env
```

Минимальный набор для запуска по HTTPS на своём домене:

```dotenv
PORT=3001
FRONTEND_URL=https://app.example.com
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
DATABASE_FILE=./data/bevhub.db
```

Файл `.env` содержит секреты: он в `.gitignore`, не копируйте его в репозиторий и не публикуйте в образах.

## 5. Сборка frontend

```bash
npm run build         # результат в dist/ (index.html + assets/)
```

Если frontend обслуживается **другим** доменом, чем API, задайте до сборки:

```dotenv
VITE_API_URL=https://api.example.com
COOKIE_SAMESITE=none
```

`VITE_API_URL` встраивается в bundle в момент сборки — менять его после `npm run build` бессмысленно, нужна пересборка.

## 6. Запуск backend

```bash
npm run start-server          # foreground, для проверки
# или напрямую
node --disable-warning=ExperimentalWarning server.js
```

Для постоянной работы — systemd-юнит (`/etc/systemd/system/bevhub.service`):

```ini
[Unit]
Description=BevHubAI API and render queue
After=network.target

[Service]
Type=simple
User=bevhub
WorkingDirectory=/opt/bevhub
EnvironmentFile=/opt/bevhub/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=3
# один процесс: API, очередь рендера и фоновые задачи живут внутри него
StandardOutput=append:/var/log/bevhub.log
StandardError=append:/var/log/bevhub.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bevhub
sudo systemctl status bevhub
```

Флаг `--disable-warning=ExperimentalWarning` убирает шумное предупреждение `node:sqlite` из логов; на работу не влияет.

## 7. Раздача frontend из `dist`

Backend **не** раздаёт `dist` — статику отдаёт reverse proxy (nginx/caddy) или любой статический сервер. Это разделение также означает, что `/api` идёт на Node, а всё остальное — из `dist` без обращения к Node.

```bash
sudo mkdir -p /var/www/bevhub
sudo cp -r dist/* /var/www/bevhub/
```

При обновлении frontend: `npm run build` → скопировать `dist/*` → перезапускать backend не нужно.

## 8. Reverse proxy `/api`

nginx (`/etc/nginx/sites-available/bevhub`):

```nginx
server {
    listen 443 ssl http2;
    server_name app.example.com;

    ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

    root /var/www/bevhub;
    index index.html;

    # SPA: все неизвестные пути отдаём index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API и файлы — только на Node
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 12m;     # загрузка фото: лимит приложения 10 МБ
        proxy_read_timeout 300s;      # генерация видео может идти дольше
    }
}
```

`client_max_body_size` обязателен: без него nginx отдаёт 413 до попадания в приложение. `X-Forwarded-*` нужны, потому что приложение доверяет `loopback` (`app.set('trust proxy', 'loopback')`) и берёт IP клиента для лимитов.

Caddy — короче, сертификаты получает сам:

```caddy
app.example.com {
    root * /var/www/bevhub
    try_files {path} {path}/ /index.html
    handle /api/* {
        reverse_proxy 127.0.0.1:3001
    }
}
```

## 9. HTTPS и `COOKIE_SECURE=true`

Сессия хранится в cookie `bh_session` (HttpOnly). Для production по HTTPS:

```dotenv
COOKIE_SECURE=true
```

Проверьте, что cookie уходит с флагом Secure, иначе токен сессии может быть передан по HTTP:

```bash
curl -sI -X POST https://app.example.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"..."}' | grep -i set-cookie
# ожидается: ... HttpOnly; Secure; SameSite=Lax
```

При `COOKIE_SAMESITE=none` флаг `Secure` включается принудительно, поэтому `none` без HTTPS не работает — браузер просто не пришлёт cookie.

## 9a. Заголовки безопасности и CSP

Backend (`server.js`) отдаёт на **каждый** ответ:

| Заголовок | Значение |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `same-origin` |
| `X-Frame-Options` | `DENY` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` |
| `Strict-Transport-Security` | `max-age=15552000` — **только для HTTPS-запросов**, без `includeSubDomains` и `preload` |
| `Content-Security-Policy-Report-Only` | политика (см. ниже) |
| `Content-Security-Policy` | та же политика, но **только при `CSP_REPORT_ONLY=false`** |

CSP в этом релизе **в режиме отчёта**: нарушения не блокируются, а попадают в консоль браузера. Политика рассчитана на этот фронтенд (без внешних CDN):

```
default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:;
font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

`style-src 'unsafe-inline'` нужен из-за inline-стилей React — это единственное послабление. `script-src 'self'` работает, потому что production-сборка Vite не содержит inline-скриптов. Если frontend живёт на другом домене, `connect-src` дополнительно получает `VITE_API_URL` (переменная читается и сервером).

**Важно:** backend не раздаёт `dist`, поэтому HTML frontend получает заголовки от reverse proxy. Добавьте в nginx-блок из §8:

```nginx
add_header Content-Security-Policy-Report-Only "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "same-origin" always;
add_header X-Frame-Options "DENY" always;
add_header Strict-Transport-Security "max-age=15552000" always;
```

Переключение в enforcing: `CSP_REPORT_ONLY=false` в `.env` (для API) и замена `Content-Security-Policy-Report-Only` на `Content-Security-Policy` в nginx. Сначала убедитесь, что отчёт чистый.

## 10. `COOKIE_SAMESITE`: один домен или разные

| Схема | `FRONTEND_URL` | `COOKIE_SAMESITE` | Примечание |
|---|---|---|---|
| Один домен: `https://app.example.com` отдаёт и frontend, и проксирует `/api` | `https://app.example.com` | `lax` (по умолчанию) | рекомендуется; работает и с CDN |
| Разные домены: `app.example.com` + `api.example.com` | `https://app.example.com` | `none` | только по HTTPS; нужен `VITE_API_URL=https://api.example.com` при сборке |

Проверка после настройки: откройте сайт, войдите, обновите страницу — сессия должна сохраниться, а картинки и видео — загрузиться.

## 11. FFmpeg/ffprobe, если они не из npm

По умолчанию используются бинарники из `node_modules`:

```bash
node -e "console.log(require('@ffmpeg-installer/ffmpeg').path)"
node -e "console.log(require('@ffprobe-installer/ffprobe').path)"
```

Если нужны системные сборки (например, своя сборка с libx264), установите их и укажите пути:

```bash
# Ubuntu/Debian
sudo apt-get install -y ffmpeg
which ffmpeg ffprobe       # /usr/bin/ffmpeg, /usr/bin/ffprobe
```

```dotenv
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
```

Оба бинарника обязательны: `ffmpeg` собирает видео, `ffprobe` проверяет готовый файл перед публикацией и отбраковывает повреждённый рендер.

## 12. Установка Python и Edge TTS

Edge TTS даёт бесплатные нейронные голоса, включая **узбекские** (`uz-UZ-MadinaNeural`, `uz-UZ-SardorNeural`) — единственный бесплатный источник узбекской озвучки в проекте. Без него узбекский текст будет прочитан русским голосом, и видео будет помечено как озвучка не на нужном языке.

```bash
# Ubuntu/Debian
sudo apt-get install -y python3 python3-venv
python3 --version          # 3.10+

# Windows: установщик с https://www.python.org (проверьте «Add python.exe to PATH»)
python --version
```

Проверьте, что пакет встал, до настройки сервиса:

```bash
.venv-tts/bin/python -m edge_tts --list-voices | head -5
```

## 13. Создание `.venv-tts`

Отдельное виртуальное окружение нужно, чтобы не ставить пакеты в системный Python:

```bash
cd /opt/bevhub
python3 -m venv .venv-tts
.venv-tts/bin/pip install --upgrade pip
.venv-tts/bin/pip install edge-tts
```

```powershell
# Windows
python -m venv .venv-tts
.\.venv-tts\Scripts\python.exe -m pip install --upgrade pip
.\.venv-tts\Scripts\python.exe -m pip install edge-tts
```

`edge-tts` — единственная зависимость. `.venv-tts` уже в `.gitignore`; каталог не коммитится и не копируется на сервер.

Приложение ищет интерпретатор так: `EDGE_TTS_PYTHON` → `./.venv-tts` (`.venv-tts/bin/python` или `.venv-tts\Scripts\python.exe`) → `python` из PATH. Если venv лежит в другом месте, укажите путь явно.

## 14. `EDGE_TTS_PYTHON`, `EDGE_TTS_DISABLED`, `TTS_PROVIDER_ORDER`

```dotenv
# путь к интерпретатору с установленным edge-tts (если venv нестандартный)
# EDGE_TTS_PYTHON=/opt/bevhub/.venv-tts/bin/python

# полностью отключить Edge TTS (например, для офлайн-стенда)
# EDGE_TTS_DISABLED=false

# порядок провайдеров: первый, кто озвучит язык, и озвучивает
TTS_PROVIDER_ORDER=edge,google,windows-sapi
```

`TTS_PROVIDER_ORDER` — это порядок, `TTS_PROVIDER` — фильтр набора (`auto` / `local` / `google`):

- `auto` (по умолчанию) — все настроенные провайдеры;
- `local` — исключает онлайн-провайдер `google`; `edge` и Windows SAPI остаются;
- `google` — исключает Windows SAPI.

`local` **не** делает озвучку полностью офлайновой: `edge-tts` тоже обращается к сети. Для офлайн-показа: `TTS_PROVIDER=local` + `EDGE_TTS_DISABLED=true` (останется Windows SAPI).

## 15. Проверка голосов RU/UZ/EN после развёртывания

1. Статус провайдеров:

```bash
curl -s https://app.example.com/api/health | python3 -m json.tool
```

В блоке `ttsProviders` каждый провайдер должен быть `available: true`, а у `edge` — языки `uz, ru, en`.

2. Живая проверка голоса (сценарий без AI — офлайн-шаблон):

```bash
curl -s -X POST https://app.example.com/api/scripts \
  -H 'Content-Type: application/json' \
  -d '{"productName":"UZ test","description":"Kofe mashinasi, kafolat bor","cta":"Hozir buyurtma bering","language":"uz","style":"dynamic","category":"product"}'
# в ответе sourceKind=template (если AI не настроен) — это нормально
```

3. Создайте по одному видео на RU, UZ и EN (интерфейс или API) и проверьте в карточке видео: «Озвучка» должна называть реальный провайдер и язык. Если для языка нет точного голоса, видео будет помечено как озвучка на другом языке — это защита от выдачи русского текста за узбекский.

## 16. Создание резервных копий

Приложение делает снимок базы при старте и далее раз в 24 часа:

```bash
ls -la data/backups/
# bevhub-2026-11-15T06-20-28.db
```

Снимок делается через `VACUUM INTO` — согласованная копия, безопасная во время работы рендера. Хранится 10 последних файлов, более старые удаляются автоматически.

Для production этого мало: копии лежат на том же диске. Добавьте выгрузку в другую систему (пример для off-site копии раз в сутки):

```bash
# /etc/cron.daily/bevhub-backup
#!/bin/sh
set -e
cd /opt/bevhub
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
aws s3 cp "data/backups/$(ls -1 data/backups | sort | tail -1)" \
  "s3://my-bucket/bevhub/bevhub-$STAMP.db" \
  --storage-class STANDARD_IA
find data/backups -name '*.db' -mtime +14 -delete
```

Проверяйте восстановление регулярно, а не только факт создания файла.

## 17. Восстановление базы из резервной копии

Восстановление на отдельном сервере или в тестовый каталог — исходную базу не трогаем:

```bash
cd /opt/bevhub
sudo systemctl stop bevhub          # обязательно: база не должна быть открыта на запись
cp data/bevhub.db data/bevhub.db.before-restore
cp data/backups/bevhub-2026-11-15T06-20-28.db data/bevhub.db
rm -f data/bevhub.db-wal data/bevhub.db-shm   # WAL от старой базы не переносим
sudo systemctl start bevhub
```

Проверка целостности и содержимого до запуска:

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('data/bevhub.db',{readOnly:true});
console.log('integrity:', db.prepare('PRAGMA integrity_check').get());
console.log('users:', db.prepare('SELECT COUNT(*) n FROM users').get().n);
console.log('videos:', db.prepare('SELECT COUNT(*) n FROM videos').get().n);
db.close();"
# integrity: { integrity_check: 'ok' }
```

Если после восстановления видео помечены `failed` с текстом «Файл видео не найден на сервере» — MP4 лежат в `uploads/videos` и не входят в снимок базы; их нужно переносить отдельно (`rsync -a uploads/ ...`).

## 18. Проверка `/api/health`

```bash
curl -s https://app.example.com/api/health | python3 -m json.tool
```

```json
{
  "ok": true,
  "database": true,
  "ffmpeg": true,
  "ffprobe": true,
  "ffmpegVersion": "ffmpeg version ... Copyright (c) ...",
  "ffprobeVersion": "ffprobe version ...",
  "subtitleFont": true,
  "ttsMode": "auto",
  "maleVoiceLanguages": ["en", "uz"],
  "aiProviders": [
    {
      "id": "openai",
      "label": "OpenAI",
      "kind": "cloud",
      "model": "gpt-4o-mini",
      "configured": true,
      "available": false,
      "lastError": { "code": "quota", "message": "You have no credits remaining.", "at": "2026-11-15T06:20:37.864Z" }
    }
  ],
  "aiActive": false,
  "ttsProviders": [
    { "id": "edge", "label": "Edge Neural (...)", "configured": true, "available": true, "languages": ["uz", "ru", "en"] },
    { "id": "google", "label": "Google Translate TTS (...)", "configured": true, "available": true, "languages": ["ru", "en"] },
    { "id": "windows-sapi", "label": "Windows SAPI (...)", "configured": true, "available": true, "languages": ["ru", "en"] }
  ]
}
```

На что смотреть:

- `ok: true` — сервер жив, оба бинарника FFmpeg найдены;
- `ffmpeg` / `ffprobe` / `subtitleFont` — `true` (пути в `ffmpeg`/`ffprobe`, флаг в `subtitleFont`); если `subtitleFont: false`, субтитры не отрисуются — задайте `SUBTITLE_FONT`;
- `ttsProviders[].available` — `true` у провайдеров, которые реально могут озвучить; у `edge` должны быть языки `uz, ru, en`;
- `aiProviders[].configured` — ключ задан; `available` — провайдер жив и не в backoff; `lastError.code` — причина (`auth`, `quota`, `rate_limit`, `server`, `timeout`, `network`);
- `aiActive: true` — только если хотя бы один AI-провайдер настроен **и** доступен.

## 19. Автоматическое удаление файлов: kill-switch

Сервер **не удаляет пользовательские файлы сам**. Пока переменные уборки не заданы явно, работает
режим `off`: каталоги переиспользуются как есть, всё лишнее остаётся на диске и попадает только в отчёт.

| Переменная | Что разрешает | По умолчанию |
|---|---|---|
| `CLEANUP_ENABLED` | глобальный выключатель. Может только **запретить** удаление, разрешить сам не может | `false` |
| `CLEANUP_ORPHAN_MODE` | `uploads/images` без ссылки в БД и `uploads/videos` без строки в `videos` | `off` |
| `CLEANUP_TMP_MODE` | черновики **этого** запуска: `uploads/tmp/<videoId>/<runId>` и неудавшийся `<videoId>.<runId>.part.mp4` | `off` |
| `CLEANUP_UPLOAD_TMP_MODE` | **заблокировано**: содержимое `uploads/tmp` при старте не удаляется ни при каком значении | `off` |
| `CLEANUP_BACKUPS_MODE` | ротация `data/backups` (`BACKUP_KEEP`, минимум 1 файл) | `off` |
| `CLEANUP_MISSING_LINKS_MODE` | снять `videos.video_file`, если файла действительно нет (изменение БД, не файла) | `off` |

Режимы: `off` — не трогать; `dry-run` — посчитать кандидатов и напечатать отчёт; `apply` — удалить
подтверждённых кандидатов (**требует** `CLEANUP_ENABLED=true`).

```bash
# только отчёт, ничего не удаляется: база открывается read-only
npm run cleanup:scan
npm run cleanup:scan -- --json > report.json
```

### Что именно считается кандидатом

Кандидат — **только** файл, у которого есть своя строка в `files`, эта строка помечена базой как
«сирота» (не используется ни одним `video_assets` и ни одним логотипом `brand_kits`) **и** файл старше
`ORPHAN_FILE_TTL_HOURS`. Всё остальное не удаляется никогда:

| Статус | Значение | Удаляется автоматически |
|---|---|---|
| `KNOWN_IN_DB` | строка в БД есть, файл используется | нет |
| `UNKNOWN_IN_DB` | файл на диске есть, строки в БД нет | **нет, никогда** |
| `NEEDS_MANUAL_REVIEW` | файл не удалось прочитать/stat/unexpected тип | нет, только ручная проверка |
| `PATH_INVALID` | не-файл, сим-ссылка, некорректное имя | нет |
| `MISSING_ON_DISK` | строка в БД есть, файла нет | нет (нечего удалять) |

### Что попадает в инвентаризацию

Сканируется **всё дерево `uploads`**, а не только два каталога, на которые ссылается база:

| Область (`kind`) | Каталог | Откуда берётся «знает ли БД» | Что возможно |
|---|---|---|---|
| `images` | `uploads/images` | строка в `files` (`filename`) | `referenced`, `orphan-row`, `too-new`, `unknown-in-db` |
| `videos` | `uploads/videos` | строка в `videos` (`video_file`) | `referenced`, `too-new`, `unknown-in-db` |
| `audio` | `uploads/audio` | нет ни одной таблицы со ссылкой на аудиофайл | только `outside-database-scope` → ручная проверка |
| `root` | файлы прямо в `uploads` и все прочие вложенные каталоги | нет | только `outside-database-scope` → ручная проверка |

Дополнительно:

- **Вложенные каталоги** обходится на глубину до 4 уровней. Файл ниже уровня `images`/`videos` — это
  `NEEDS_MANUAL_REVIEW` с причиной `nested-path`: строка в БД хранит только имя файла, поэтому совпадение
  по имени во вложенном каталоге не доказывает, что это тот самый файл.
- `uploads/tmp` **не входит** в эту инвентаризацию — это отдельная заблокированная категория уборки, и
  её содержимое не смешивается с отчётом о пользовательских файлах.
- Ограничения обхода (`MAX_DEPTH`, `MAX_ENTRIES`) при достижении ставят `blocked=INVENTORY_LIMIT_REACHED`:
  неполная инвентаризация не даёт права на удаление.
- Каждая область обязана лежать внутри корня `uploads`; иначе весь запуск блокируется (`SCOPE_OUTSIDE_ROOT`).
- Сим-ссылка и точка повторного разбора (junction на Windows) не раскрываются: запись попадает в отчёт как
  `NEEDS_MANUAL_REVIEW` с причиной `symlink`, а каталог-ссылка не обходится.
- Каждый файл попадает в отчёт ровно один раз: корневая область пропускает `images`, `videos`, `audio` и
  `tmp`, а совпадение путей отсекается дополнительно.

Отсутствие `uploads/audio` — не ошибка: каталог создаётся при первой записи, а до этого считается пустым.

**Файлы без записи в БД не удаляются автоматически ни при каких условиях** — ни при возрасте, ни при
соотношении «известных/неизвестных». Эвристика «неизвестных меньше, чем известных» убрана: она была
основанием для удаления, а не защитой. Единственный способ удалить такой файл — ручная процедура
оператора с явным указанием конкретного пути (отчёт `cleanup:scan` перечисляет их все).

Что делает уборку предсказуемой:

- отсутствующая переменная, опечатка или неизвестное значение = `off`;
- одна категория не может включить другую;
- `dry-run` не требует глобального выключателя — инвентаризация доступна всегда;
- **Корень области проверяется до первого чтения каталога** (`lstat` по `uploads`, `uploads/images`,
  `uploads/videos`, `uploads/audio`). Если корень — сим-ссылка, junction Windows или иная точка
  повторного разбора, область закрывается целиком: содержимое не обходится и не классифицируется, а
  запуск блокируется (`UPLOADS_DIR_IS_LINK`, `IMAGES_DIR_IS_LINK`, `VIDEOS_DIR_IS_LINK`,
  `AUDIO_DIR_IS_LINK`);
- **Физический путь обязан определяться.** Если `realpath` корня или его родителя не отвечает, область
  считается небезопасной, а не обычной: `*_DIR_PATH_UNRESOLVED` (например `UPLOADS_DIR_PATH_UNRESOLVED`).
  Каталог, который разрешается за пределы корня области во время обхода, тоже блокирует запуск
  (`INVENTORY_PATH_ESCAPE`). Обычный каталог никогда не принимается за ссылку, а ссылка — за каталог;
- **Доверенный физический корень** задаётся параметром `trustedRoot` (в сервере это корень проекта).
  `uploads` обязан разрешаться внутри него, а `images`, `videos`, `audio` — внутри `uploads`; иначе
  `UPLOADS_DIR_OUTSIDE_ROOT` / `SCOPE_OUTSIDE_ROOT`. Сравнение всегда по разрешённым путям, поэтому
  перенаправленный *предок* (junction на уровень выше) остаётся внутри своего реального корня и не
  считается побегом; `apply` повторно проверяет корни и при ссылке или неразрешимом пути не удаляет ничего;
  Сим-ссылка не считается каталогом: `lstat().isSymbolicLink()` на Windows верно и для junction, а
  реальный путь дополнительно сравнивается с «родитель + имя», поэтому репанс-поинт, который Node не
  считает ссылкой, тоже не проходит. Отсутствие `uploads/audio` ссылкой не считается — это пустая область;
- инвентаризация останавливается целиком (`blocked`), а не удаляет «что успела», если: база
  недоступна, каталог не читается, база пуста, БД знает меньше файлов, чем лежит на диске
  (признак чужой/тестовой базы), обход упёрся в ограничение глубины или количества записей
  (`INVENTORY_LIMIT_REACHED`), либо одна из областей лежит вне корня `uploads` (`SCOPE_OUTSIDE_ROOT`).
  Ни одна из этих ситуаций не приводит к удалению;
- `apply` перепроверяет каждый файл независимо от отчёта: статус должен быть `KNOWN_IN_DB`, причина —
  `orphan-row`, файл — обычным файлом, строка — всё ещё существовать в БД, а отпечаток файла
  (размер, mtime, inode) — совпадать с тем, что был при сканировании. Файл, изменённый между сканом и
  удалением, пропускается (`changed-since-scan`) вместе со своей строкой;
- `*.part.mp4` **никогда** не удаляется автоматически: имя не доказывает, что файл ничей, а
  кросс-процессное владение не проверяемо. Возраст файла доказательством не считается. Удаление
  вернётся только вместе с блокировками этапа C;
- уборка `uploads/tmp` при старте **заблокирована**: каталог может быть рабочим для рендера, который
  идёт в другом процессе, и записи о владении каталогом нет. `CLEANUP_UPLOAD_TMP_MODE=apply`
  принудительно игнорируется — сервер только сообщает количество оставшихся записей;
- восстановление после перезапуска (`recoverOnStartup`) только сообщает: прерванные задачи,
  видео без файла, нечитаемые файлы. `videos.video_file` не очищается; для этого есть отдельный
  явно включаемый шаг `CLEANUP_MISSING_LINKS_MODE=apply` (и только если каталог прочитан и файла
  действительно нет);
- ротация бэкапов смотрит только на файлы собственного формата `bevhub-*.db`, не удаляет последний
  снапшот и не трогает ничего, что не удалось прочитать.

### Владение черновиками рендера

Один запуск задачи получает собственный `runId` (`crypto.randomUUID()`), и от него зависят оба имени:

| Путь | Имя |
|---|---|
| рабочий каталог | `uploads/tmp/<videoId>/<runId>` |
| файл рендера | `uploads/videos/<videoId>.<runId>.part.mp4` |
| публикуемый файл | `uploads/videos/<videoId>.mp4` |

Каталог запуска создаётся **эксклюзивно** (`mkdir` без `recursive`). Это касается только каталога:
успешный `mkdir` — единственное доказательство владения, и `finally` удаляет каталог **только** если
этот запуск его создал. Если `mkdir` упал с `EEXIST` (имя занято), каталог и его содержимое остаются
нетронутыми, а в лог пишется предупреждение: у такого пути владение не доказано.

**Строгой эксклюзивности создания самого MP4 нет.** Файл рендера создаёт ffmpeg, а `fluent-ffmpeg`
всегда добавляет `-y` (`node_modules/fluent-ffmpeg/lib/processor.js:246`), поэтому ffmpeg молча
перезапишет файл, который уже лежит по этому пути, — флага `-n`/`O_EXCL` мы не передаём. От порчи
чужого файла защищает **уникальность имени**: в нём есть `runId`, то есть UUID, выданный этому запуску.
Это вероятностная, а не архитектурная гарантия; если нужна настоящая эксклюзивность, её придётся
добавить отдельно (сначала `-n` или `O_EXCL`, потом снятие блокировки с `uploadTemp`).

Удаление черновика управляется `CLEANUP_TMP_MODE` и проходит через `server/safe-remove.js`, который
дополнительно требует, чтобы mtime файла был не старше начала запуска: файл, существовавший до
запуска, не удаляется, даже если имя совпало.

### Задокументированные исключения

Три удаления не гейтятся kill-switch, потому что удаляют файл, который текущая операция создала
секунду назад и на который никто, кроме неё, не ссылается. Все три проходят через
`server/safe-remove.js`, где проверяется: путь — прямой ребёнок каталога операции, имя совпадает с
созданным, это обычный файл (не сим-ссылка), mtime не старше начала операции и (для загрузок) на это
имя нет строки в `files`.

1. `server/tts/providers/edge.js` — scratch `<outPath>.try.mp3` неудавшейся попытки синтеза.
2. `server.js` `POST /api/files` — временный файл multer, если вставка строки в БД упала.
   Если имя уже занято существующей строкой, файл остаётся на диске.
3. `server/generation.js` — рабочий каталог запуска `uploads/tmp/<videoId>/<runId>` в `finally`, и
   только если этот запуск сам его создал (`removeRunWorkDir`). Каталог, созданный кем-то другим,
   не удаляется.

Массовое удаление остаётся выключенным и в production: включать его нужно отдельно, на каждой
категории, осознанно.

## Ограничения SQLite для мультитенантного SaaS

- **Один писатель.** SQLite допускает много читателей и одного писателя; очередь рендера и запись статусов конкурируют за один файл. `busy_timeout` (5 с) и WAL снижают, но не убирают отказы `SQLITE_BUSY` под нагрузкой.
- **Один процесс.** Очередь рендера живёт в памяти процесса: два инстанса на одной базе будут рендерить одну задачу дважды. Масштабирование «вширь» невозможно без внешней БД и внешней очереди.
- **Файловая БД.** Нет сетевого доступа, реплик и managed-бэкапов. Для нескольких клиентов нужен PostgreSQL (или MySQL) и S3-совместимое хранилище для фото и MP4.
- **Бэкап.** Локальный снимок раз в сутки; для production — регулярная выгрузка в объектное хранилище и проверка восстановления.
- **Миграции.** Схема расширяется на старте (`ALTER TABLE ... ADD COLUMN`), но это не система миграций: при откате кода на старую версию новые колонки останутся.

Вывод: текущая конфигурация рассчитана на один сервер и десятки активных пользователей. Для публичного запуска с несколькими клиентами и SLA требуется переход на PostgreSQL, внешнюю очередь задач и объектное хранилище.

## Проверки

```bash
npm run typecheck
npm run lint
npm run build
# тесты защиты файловой системы (работают только в %TEMP%\bevhub-safety-*)
npm run test:node
```