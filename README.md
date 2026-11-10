# Tilawah API

Express + TypeScript API for Tilawah. Accounts, bookmarks, goals, sessions, mistakes, and Premium live in MongoDB (Mongoose). Recitation and voice search transcribe with the free Quran model `tarteel-ai/whisper-base-ar-quran`.

The process listens on `0.0.0.0` and `$PORT` (8787 if unset).

## Run

```bash
cp .env.example .env
# set MONGODB_URI and JWT_SECRET
npm ci
npm run build
npm start
```

## Docker

Build context is this directory. The Dockerfile is `./Dockerfile`.

```bash
docker build -t tilawah-api .
docker run --rm -p 8787:8787 --env-file .env tilawah-api
```

On Render, set the service port to `$PORT`. The image does not bake a `PORT` value, so the platform’s `$PORT` is what the process binds.

## Environment

Copy `.env.example`. Required for accounts: `MONGODB_URI` (Atlas `mongodb+srv://…` works) and `JWT_SECRET`.

Transcription, in order when `TRANSCRIPTION_PROVIDER=auto`:

1. `HF_TOKEN` — Hugging Face Inference API, model `tarteel-ai/whisper-base-ar-quran`.
2. `SELFHOST_ASR_URL` — any service that accepts multipart field `file` and returns `{ "text": "..." }`.
3. `OPENAI_API_KEY` — optional. Never required.

`GOOGLE_CLIENT_ID` is only for Google sign-in. Email and password work without it.

`REVENUECAT_WEBHOOK_SECRET` protects `POST /api/webhooks/revenuecat`, which sets the `premium` entitlement (`REVENUECAT_ENTITLEMENT`).

`GET /health` stays up even when `MONGODB_URI` is missing. Account routes then return 503.
