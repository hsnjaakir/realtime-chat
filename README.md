# Realtime Chat

Realtime chat app with:
- JWT auth (register/login)
- Room-based messaging
- Private messages
- Message persistence (SQLite by default, Postgres optional)

## Run locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy environment file:
   ```bash
   cp .env.example .env
   ```
3. Start the server:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3000` in two tabs/windows and register two users.

## Persistence

- Default: local SQLite database file at `chat.db`.
- Optional Postgres: set `DATABASE_URL` in `.env`.
