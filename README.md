# Nano Studio

Генератор изображений на **WaveSpeed AI** (FLUX Schnell + Seedream 5.0 Pro). Простой интерфейс: промпт, 5 зон референсов (лицо/позы/одежда/продукт/фон), сохранённые персонажи, история. Прочная архитектура: постоянный Node-сервер + хранение на диске + Docker.

## Возможности
- Промпт с опциональным **голосовым вводом** (Chrome/Edge).
- **Референсы (5 ролей):** «Лицо / личность», «Позы», «Одежда», «Продукт», «Фон» — суммарно до 10.
- **Логика фона:** есть фото → оно становится окружением; пусто → чистый белый фон (если в промпте не описан другой).
- **Промпт необязателен:** пусто + референсы → авто-режим; с текстом → ваш промпт + якоря ролей.
- **Сохранённые персонажи:** набор фото лица под именем → выбираете из списка → лицо подставляется автоматически.
- Три режима: **Быстро** (FLUX Schnell, ~$0.015) / **Черновик** (Seedream Pro 1K, ~$0.045) / **Качество** (Seedream Pro 2K, ~$0.09).
- **Разрешение 1K / 2K.**
- **Прикидка стоимости** перед генерацией.
- **Хранение результатов + История** (переживает перезагрузку и рестарт).
- ✨ Улучшить промпт (Atomesus, опционально).

## Ключ API
WaveSpeed AI → Dashboard → **API Keys** → Generate (https://wavespeed.ai).
Новым аккаунтам дают $1 триал-кредит; для полного доступа нужен top-up.
Вставьте в `.env` как `WAVESPEED_API_KEY=...` (или в Railway → Variables).

## Запуск — Docker (рекомендуется)
```bash
cp .env.example .env          # впишите WAVESPEED_API_KEY
docker compose up --build     # → http://localhost:3000
```

## Запуск — Node (без Docker)
```bash
npm install
cp .env.example .env          # впишите WAVESPEED_API_KEY
npm start                      # → http://localhost:3000
```

## Деплой (Railway / Render / Fly / VPS)
1. Проект из репозитория (сборка по `Dockerfile`).
2. Переменная окружения: `WAVESPEED_API_KEY`.
3. Volume на `/app/data` (чтобы история не пропадала).

## Архитектура
```
nano-studio/
├── public/               статичный фронтенд (vanilla JS)
├── lib/
│   ├── engine.js         GenerationEngine (WaveSpeed API, async submit+poll)
│   ├── store.js          хранение: изображения на диск + записи истории
│   ├── handler.js        валидация → генерация → сохранение → URL
│   └── atomesus.js       опц. улучшение промпта
├── server.js             Express: статика, /images, API
├── Dockerfile  docker-compose.yml
└── data/                 (runtime) images/ + records/ + characters/
```

## Модели (WaveSpeed AI, один ключ)
| Режим | Модель | Цена/картинка | Референсы |
|---|---|---|---|
| Быстро | FLUX Schnell | ~$0.015 | нет (текст) |
| Черновик | Seedream 5.0 Pro Edit (1K) | ~$0.045 | до 10 |
| Качество | Seedream 5.0 Pro Edit (2K) | ~$0.09 | до 10 |

Seedream Edit: первый референс бесплатно, каждый доп. +$0.003.

## API
- `GET /api/health` — возможности.
- `POST /api/generate` — `{prompt, aspectRatio, size, count, tier, faceRefs[], poseRefs[], garmentRefs[], productRefs[], backgroundRefs[], characterId, enhance}`.
- `GET /api/history` / `DELETE /api/history/:id`.
- `GET/POST/DELETE /api/characters`.

## Рост до мультипользователя
| Слой | Сейчас | Потом |
|---|---|---|
| Auth | один юзер (`local`) | сессии / OAuth / JWT |
| Хранение | диск | S3/R2 + Postgres |
| Квоты | нет | на пользователя |
| Движок | WaveSpeed | любой (интерфейс `generate()`) |

## Заметки
- Node.js ≥ 18 (глобальный `fetch`).
- WaveSpeed API — асинхронный (submit → poll); движок обрабатывает это прозрачно.
- Референсы с лицами реальных людей — только с их согласия.
