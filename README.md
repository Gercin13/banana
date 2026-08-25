# Nano Studio (Vercel)

Генератор изображений и видео — **Vercel Serverless** + **Vercel Blob** + WaveSpeed AI + NVIDIA NIM.

Клиентский поллинг снимает все ограничения таймаутов: видео (1-3 мин) и тяжёлые модели работают даже на **Free tier ($0)**.

## Деплой на Vercel
1. Fork/push в GitHub → Vercel → **Add New Project** → Import.
2. **Storage** → Add → **Blob** (создаст `BLOB_READ_WRITE_TOKEN` автоматически).
3. **Settings → Environment Variables**:
   - `WAVESPEED_API_KEY` — wavespeed.ai → Dashboard → API Keys
   - `NVIDIA_API_KEY` — build.nvidia.com/settings
4. Deploy. Готово.

## Архитектура
```
nano-studio/
├── public/            статичный фронтенд (Vercel CDN)
├── api/               Vercel Serverless Functions
│   ├── generate.js    POST — submit task (instant return)
│   ├── poll.js        GET  — check status, save to Blob
│   ├── health.js      GET  — capabilities
│   ├── history.js     GET/DELETE — history
│   ├── characters.js  GET/POST/DELETE — saved characters
│   └── upscale.js     POST — submit upscale
├── lib/
│   ├── engine.js      WaveSpeed + NVIDIA API calls
│   ├── store.js       Vercel Blob storage
│   └── atomesus.js    optional prompt enhancement
├── vercel.json
└── package.json
```

## Как работает (клиентский поллинг)
1. `POST /api/generate` → функция отправляет задачу в WaveSpeed → мгновенно возвращает `taskId` (< 1 сек)
2. Браузер поллит `GET /api/poll?resultUrl=...` каждые 3 сек (каждый полл < 1 сек)
3. Когда `completed` → функция скачивает результат в Vercel Blob → возвращает URL
4. Для NVIDIA FLUX.1-dev (< 10 сек): прямой синхронный ответ без поллинга

## Модели
| Режим | Модель | Цена | Провайдер |
|---|---|---|---|
| Быстро | FLUX.1-dev | бесплатно (кредиты) | NVIDIA |
| Черновик | Seedream 5.0 Pro Edit 1K | ~$0.045 | WaveSpeed |
| Качество | Seedream 5.0 Pro Edit 2K | ~$0.09 | WaveSpeed |
| Видео | WAN 2.2 / WAN 2.5 | ~$0.30+/видео | WaveSpeed |
