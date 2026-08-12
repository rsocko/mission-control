# Public Setup Guide

This guide starts a local development instance with synthetic configuration.

## Prerequisites

- Node.js 22 LTS
- npm
- Git
- Optional: a local Ollama-compatible endpoint

## Install and configure

```bash
git clone https://github.com/rsocko/mission-control.git
cd mission-control
npm install
cp .env.example .env.local
```

Use a local-only database and a synthetic AI endpoint in `.env.local`:

```dotenv
MC_DB_PATH=./data/mission-control-dev.db
AI_PROVIDER=ollama
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=example-local-model
```

Do not paste production credentials or connector exports into local fixtures,
issues, screenshots, or logs.

## Start and verify

```bash
npm run dev -- --port 3098
```

Open `http://localhost:3098`. The application creates and migrates the local
SQLite database on first access.

Connectors are optional. Configure one at a time with a dedicated test account
and the minimum permissions documented for that connector.
