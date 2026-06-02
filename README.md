# Realtime Chat

Realtime chat app with:
- JWT auth (register/login)
- Logout with server-side session invalidation
- Password reset token flow (request + confirm)
- Room-based messaging
- Private messages
- Private-message history retrieval
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

## Password reset flow

- Request token using the form in the auth panel (`/api/password-reset/request`).
- Confirm with token + new password (`/api/password-reset/confirm`).
- For local testing, set `DEV_EXPOSE_RESET_TOKEN=true` in `.env` to return token in API response.
