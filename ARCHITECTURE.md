# Watchtower API Architecture

> **Version:** 0.1.0  
> **Live URL:** https://watchtower-api.watchtower-host.workers.dev/  
> **Last Updated:** 2026-01-28

## Overview

Watchtower is a simple backend for indie game developers. No DevOps, no infrastructure management—just APIs that work.

**Core Features:**
1. **Cloud Saves** — Per-player key-value storage
2. **Multiplayer Rooms** — Create/join rooms with 4-letter codes
3. **WebSocket Relay** — Real-time message broadcasting
4. **Game Hosting** — Static file hosting for web games (v2)

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLOUDFLARE EDGE (Global)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│    ┌──────────────────────────────────────────────────────────────────┐    │
│    │                     WORKERS (API Gateway)                         │    │
│    │                                                                   │    │
│    │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │    │
│    │   │  /v1/saves  │  │ /v1/rooms   │  │ /v1/games   │             │    │
│    │   │   (REST)    │  │ (REST + WS) │  │  (REST)     │             │    │
│    │   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │    │
│    │          │                │                │                     │    │
│    └──────────┼────────────────┼────────────────┼─────────────────────┘    │
│               │                │                │                          │
│               ▼                ▼                ▼                          │
│    ┌──────────────┐  ┌─────────────────┐  ┌──────────────┐                │
│    │      KV      │  │ DURABLE OBJECTS │  │      R2      │                │
│    │   (Saves)    │  │   (GameRoom)    │  │   (Games)    │                │
│    │              │  │                 │  │              │                │
│    │ game:player: │  │  ┌───────────┐  │  │  /games/     │                │
│    │   key → JSON │  │  │  Room A   │  │  │   {id}/      │                │
│    │              │  │  │ WebSocket │  │  │    assets    │                │
│    └──────────────┘  │  │  Sessions │  │  └──────────────┘                │
│                      │  └───────────┘  │                                  │
│                      │  ┌───────────┐  │  ┌──────────────┐                │
│                      │  │  Room B   │  │  │      D1      │                │
│                      │  └───────────┘  │  │  (Metadata)  │                │
│                      │  ┌───────────┐  │  │              │                │
│                      │  │  Room C   │  │  │ users, games │                │
│                      │  └───────────┘  │  │  api_keys    │                │
│                      └─────────────────┘  └──────────────┘                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Deep Dive

### 1. Workers (API Gateway)

**Runtime:** Cloudflare Workers (V8 isolates, ~0ms cold start)  
**Framework:** [Hono](https://hono.dev) (lightweight, ~14KB)

The Worker handles all HTTP requests and routes them to the appropriate service:

```typescript
// src/index.ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { savesRouter } from './routes/saves'
import { roomsRouter } from './routes/rooms'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({ origin: '*' }))
app.route('/v1/saves', savesRouter)
app.route('/v1/rooms', roomsRouter)

export default app
```

**Why Hono?**
- Designed for edge runtimes (Workers, Deno, Bun)
- Express-like API, easy to learn
- Built-in middleware (CORS, auth, etc.)
- TypeScript-first

---

### 2. KV (Cloud Saves)

**Storage:** Cloudflare KV (eventually consistent, global replication)  
**Latency:** <50ms reads globally  
**Limits:** 25MB per value, 100K reads/day (free tier)

**Key Format:**
```
{game_id}:{player_id}:{save_key}
```

**Example:**
```
mygame:player_abc123:progress → {"level": 5, "coins": 100}
mygame:player_abc123:settings → {"music": true, "difficulty": "hard"}
```

**Why KV for Saves?**
- Global replication (players can load saves from anywhere)
- Simple key-value model matches game save patterns
- No schema migrations needed
- Generous free tier

**API Flow:**
```
Client                    Worker                    KV
  │                         │                        │
  │  POST /v1/saves/progress│                        │
  │  X-Player-ID: abc123    │                        │
  │  X-Game-ID: mygame      │                        │
  │  {"level": 5}           │                        │
  │ ───────────────────────>│                        │
  │                         │  PUT mygame:abc123:progress
  │                         │ ──────────────────────>│
  │                         │                        │
  │                         │        OK              │
  │                         │ <──────────────────────│
  │      {"success": true}  │                        │
  │ <───────────────────────│                        │
```

---

### 3. Durable Objects (Multiplayer Rooms)

**This is the key innovation for real-time multiplayer.**

**What are Durable Objects?**
- Single-threaded JavaScript objects with persistent storage
- One instance per room (identified by room code)
- Can hold WebSocket connections
- Automatically scales: 0 instances when no rooms, millions when needed

**Why Durable Objects for Rooms?**
- **Strong consistency:** All players in a room talk to the same instance
- **WebSocket support:** Native WebSocket handling with hibernation
- **State persistence:** Room state survives disconnections
- **No server management:** Cloudflare handles scaling, failover, etc.

#### GameRoom Durable Object

```typescript
// src/durable-objects/GameRoom.ts

export class GameRoom {
  private state: DurableObjectState
  private sessions: Map<string, WebSocket>  // playerId → socket
  private roomState: RoomState | null = null

  constructor(state: DurableObjectState) {
    this.state = state
    // Restore state on wake
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get('roomState')
      if (stored) this.roomState = stored
    })
  }

  // Handle HTTP requests (create, join, info)
  async fetch(request: Request): Promise<Response> { ... }

  // Handle WebSocket messages
  async webSocketMessage(ws: WebSocket, message: string) { ... }

  // Handle WebSocket close
  async webSocketClose(ws: WebSocket) { ... }

  // Broadcast to all players
  private broadcast(message: object, exclude?: string) { ... }
}
```

#### Room Lifecycle

```
1. CREATE ROOM
   ┌─────────┐     POST /v1/rooms      ┌─────────┐
   │  Game   │ ──────────────────────> │ Worker  │
   │ Client  │                         │         │
   └─────────┘                         └────┬────┘
                                            │ Generate code "ABCD"
                                            │ Get DO stub for "ABCD"
                                            ▼
                                     ┌─────────────┐
                                     │  GameRoom   │
                                     │   "ABCD"    │
                                     │  (created)  │
                                     └─────────────┘
                                            │
        { code: "ABCD" }                    │
   <────────────────────────────────────────┘

2. JOIN ROOM (WebSocket)
   ┌─────────┐   GET /v1/rooms/ABCD/ws  ┌─────────┐
   │ Player  │ ────────────────────────>│ Worker  │
   │    2    │   Upgrade: websocket     │         │
   └─────────┘                          └────┬────┘
        │                                    │ Route to DO "ABCD"
        │                                    ▼
        │                             ┌─────────────┐
        │    WebSocket established    │  GameRoom   │
        │<═══════════════════════════>│   "ABCD"    │
        │                             │             │
        │  {"type": "connected",      │  Sessions:  │
        │   "players": [...]}         │  - player1  │
        │<────────────────────────────│  - player2  │
                                      └─────────────┘

3. BROADCAST MESSAGE
   ┌─────────┐                        ┌─────────────┐
   │ Player  │  {"type": "broadcast", │  GameRoom   │
   │    1    │   "data": {x: 100}}    │   "ABCD"    │
   │         │ ══════════════════════>│             │
   └─────────┘                        │  Broadcast  │
                                      │  to all     │
   ┌─────────┐                        │  sessions   │
   │ Player  │  {"type": "message",   │             │
   │    2    │   "from": "player1",   │             │
   │         │<══════════════════════ │             │
   └─────────┘   "data": {x: 100}}    └─────────────┘

4. ROOM CLEANUP
   - Player disconnects → webSocketClose() called
   - Player removed from sessions + roomState
   - Broadcast "player_left" to remaining players
   - If room empty → storage.deleteAll(), roomState = null
   - DO hibernates (no cost when idle)
```

#### Message Protocol

**Client → Server:**
```json
// Broadcast to all players
{"type": "broadcast", "data": {...}, "excludeSelf": true}

// Send to specific player
{"type": "send", "to": "player_id", "data": {...}}

// Ping (keep-alive)
{"type": "ping"}
```

**Server → Client:**
```json
// Connection established
{"type": "connected", "playerId": "...", "room": {...}}

// Player joined
{"type": "player_joined", "playerId": "...", "playerCount": 3}

// Player left
{"type": "player_left", "playerId": "...", "playerCount": 2}

// Message from another player
{"type": "message", "from": "player_id", "data": {...}}

// Pong response
{"type": "pong", "timestamp": 1234567890}
```

---

### 4. D1 (Metadata Database)

**Storage:** Cloudflare D1 (SQLite at the edge)  
**Use Cases:** User accounts, game registry, API keys, usage tracking

**Schema (planned):**
```sql
-- Users (game developers)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

-- Games/Projects
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- API Keys
CREATE TABLE api_keys (
  key TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
```

**Why D1?**
- SQL queries for complex lookups
- Transactional writes
- Good for relational data (users → games → keys)
- 5GB free storage

---

### 5. R2 (Game Hosting) — v2

**Storage:** Cloudflare R2 (S3-compatible object storage)  
**Use Cases:** Static game files, assets, builds

**Planned Structure:**
```
watchtower-games/
├── {game_id}/
│   ├── index.html
│   ├── game.js
│   └── assets/
│       ├── sprites/
│       └── audio/
```

**Why R2?**
- Zero egress fees (unlike S3)
- Global CDN built-in
- S3-compatible (easy uploads)
- 10GB free storage

---

## API Reference

### Health Check
```
GET /
Response: {"name": "Watchtower API", "version": "0.1.0", "status": "ok"}
```

### Saves API

**Headers Required:**
- `X-Player-ID` — Unique player identifier
- `X-Game-ID` — Your game's identifier

```
# Save data
POST /v1/saves/:key
Body: {"level": 5, "coins": 100}
Response: {"success": true, "key": "progress"}

# Load data
GET /v1/saves/:key
Response: {"key": "progress", "data": {"level": 5, "coins": 100}}

# List saves
GET /v1/saves
Response: {"keys": ["progress", "settings", "inventory"]}

# Delete save
DELETE /v1/saves/:key
Response: {"success": true}
```

### Rooms API

**Headers Required:**
- `X-Player-ID` — Unique player identifier
- `X-Game-ID` — Your game's identifier

```
# Create room
POST /v1/rooms
Response: {"code": "ABCD", "wsUrl": "wss://..."}

# Get room info
GET /v1/rooms/:code
Response: {"gameId": "...", "hostId": "...", "playerCount": 3, "players": [...]}

# Join room (HTTP)
POST /v1/rooms/:code/join
Response: {"success": true, "gameId": "...", "players": [...]}

# Join room (WebSocket)
GET /v1/rooms/:code/ws?playerId=...
Upgrade: websocket
```

---

## Project Structure

```
watchtower-api/
├── src/
│   ├── index.ts              # Main worker entry, Hono app
│   ├── routes/
│   │   ├── saves.ts          # /v1/saves/* endpoints
│   │   └── rooms.ts          # /v1/rooms/* endpoints
│   ├── durable-objects/
│   │   └── GameRoom.ts       # Multiplayer room DO
│   └── utils/
│       └── codes.ts          # Room code generation
├── wrangler.toml             # Cloudflare config
├── package.json
└── tsconfig.json
```

---

## Cloudflare Resources

| Resource | Name | ID |
|----------|------|-----|
| Worker | watchtower-api | — |
| D1 Database | watchtower-db | `48370393-26b8-4482-a007-ce5ccd7f0139` |
| KV Namespace | SAVES | `ace14130d77a43879e2eb3a5c20ac9d0` |
| Durable Object | GameRoom | (auto-managed) |
| R2 Bucket | watchtower-games | (pending) |
| Subdomain | watchtower-host.workers.dev | — |

---

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Deploy to Cloudflare
npm run deploy

# View logs
npm run tail

# Run D1 migrations
npm run db:migrate
```

---

## Security Considerations

### Current (MVP)
- Player IDs are client-provided (anonymous)
- Game IDs are client-provided (honor system)
- No rate limiting (relying on Cloudflare's built-in protection)

### Planned (v1)
- API keys for game developers
- Player ID validation (JWT or signed tokens)
- Per-game rate limiting
- Request signing for sensitive operations

---

## Scaling Characteristics

| Component | Scaling Model | Limits (Free Tier) |
|-----------|---------------|-------------------|
| Workers | Auto (per-request) | 100K requests/day |
| KV | Global replication | 100K reads/day, 1K writes/day |
| D1 | Single region + replicas | 5M reads/day, 100K writes/day |
| Durable Objects | Per-room instance | 1M requests/month |
| R2 | Object storage | 10GB storage |

**Key insight:** Durable Objects scale horizontally by room. 1000 active rooms = 1000 DO instances, each handling only its own players.

---

## Roadmap

### v0.1 (Current) ✅
- [x] Cloud saves (KV)
- [x] Room create/join
- [x] WebSocket relay
- [x] Basic room management

### v0.2 (Next)
- [ ] API key authentication
- [ ] Player session tokens
- [ ] Room metadata (name, max players, private)
- [ ] Room timeout/cleanup

### v0.3
- [ ] D1 schema + migrations
- [ ] Developer dashboard (Supabase Auth)
- [ ] Usage tracking

### v1.0
- [ ] R2 game hosting
- [ ] Custom domains
- [ ] Billing (Stripe)
- [ ] SDK packages (JS, Unity, Godot)

---

## References

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Durable Objects Docs](https://developers.cloudflare.com/durable-objects/)
- [Hono Framework](https://hono.dev/)
- [WebSocket API on Workers](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
