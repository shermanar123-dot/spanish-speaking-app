# Habla Diario - Spanish Speaking App

A full-stack web application for daily Spanish speaking practice, using the Gemini API for personalized assessments, FSI-style drills, vocabulary generation, and roleplay scenarios.

## Features

- **Personalized Assessment:** 4-question OPI-style interview to determine your CEFR level (A1-C1)
- **FSI Drills:** 15 verbs × 6 tenses × 5 drill patterns with Auto-Play and Rapid-Fire modes
- **Vocabulary:** 20 high-frequency words per theme with example sentences, synonyms, and antonyms
- **Roleplay:** 13 scenarios with real-time correction and coach celebrations
- **Voice Integration:** Web Speech API for mic input and Spanish TTS output
- **Progress Tracking:** Daily goal ring, streak counter, mistake review
- **Onboarding:** 3-step tour for new users

## Quick Start (Docker)

```bash
# Clone and run
cp .env.example .env
# Edit .env to add your GEMINI_API_KEY
docker compose up -d
# Open http://localhost:8000
```

## Manual Start

```bash
npm install
cp .env.example .env
# Edit .env to add your GEMINI_API_KEY
node server.js
# Open http://localhost:3000
```

## Railway Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/...)

1. Connect this repo to Railway
2. Set `GEMINI_API_KEY`, `SESSION_SECRET`, and `FRONTEND_URL` in Railway dashboard
3. Add a volume mount at `/usr/src/app/app.db` for SQLite persistence
4. Deploy — Railway auto-detects the Dockerfile

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `SESSION_SECRET` | Yes | Random string for session encryption |
| `PORT` | No | Server port (default: 3000) |
| `FRONTEND_URL` | No | Comma-separated CORS origins |
| `FREE_USER_LIMIT` | No | Max free users (default: 20) |
| `NODE_ENV` | No | `development` or `production` |
