Bezique Game Server

Overview
- Node.js + TypeScript backend for the Bezique Score Keeper PWA.
 - Lightweight Express + WebSocket server (no database required).

Setup
- Copy `.env.example` to `.env` and adjust settings if needed.
- Start dev server: `npm run dev`.

Local dev notes
- To enable secure WebSocket (`wss://`) for the PWA during local development, create local certs (example with mkcert):
  1. Install mkcert (https://github.com/FiloSottile/mkcert)
 2. Run `mkcert -install` then `mkcert localhost` to generate `localhost.pem` and `localhost-key.pem` in the repo root.
 3. The server will pick these up automatically when present and start HTTPS/WSS.

Regenerating dependencies (clean lockfile)
- If you removed DB-related dependencies and want a fresh lockfile locally, delete `package-lock.json` and `node_modules/`, then run:

```bash
cd bezik-server
npm install
```

Data files
- The server persists assigned 4-digit player IDs to `data/used_player_ids.json` so IDs survive restarts. You can inspect or delete that file to reset the ID pool.

API
- The server primarily uses WebSocket for player discovery and realtime events.
- No database-backed REST routes are required in the lightweight server.

WebSocket
- Connect to `ws://HOST:PORT/?playerID=<id>` (or `wss://` for HTTPS) to receive events:
  - `player:online`, `player:offline`, `game:auto_joined`, `game:joined`, `game:score_updated`, `game:opponent_undo`, `game:completed`.

Notes
- Geospatial search endpoints can be added with PostGIS or POINT-based distance queries.
 - HTTPS termination is recommended in production; for local development you can create self-signed certs with `mkcert` to enable `wss://`.

