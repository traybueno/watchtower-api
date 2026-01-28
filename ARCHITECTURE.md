# Watchtower API Architecture

## Overview

Watchtower provides a simple backend for indie game developers:
- **Cloud Saves** — Per-player key-value storage
- **Rooms** — Create/join multiplayer rooms with codes
- **WebSocket Relay** — Broadcast messages to room members
- **Game Hosting** — Upload and serve web games (future)

## Tech Stack (Cloudflare)

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLOUDFLARE EDGE                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│  │   Workers   │    │  Durable    │    │     R2      │        │
│  │   (API)     │───▶│  Objects    │    │  (Games)    │        │
│  │             │    │  (Rooms)    │    │             │        │
│  └──────┬──────┘    └─────────────┘    └─────────────┘        │
│         │                                                      │
│    ┌────┴────┐                                                 │
│    ▼         ▼                                                 │
│  ┌─────┐  ┌─────┐                                             │
│  │ D1  │  │ KV  │                                             │
│  │(meta)│ │(saves)│                                            │
│  └─────┘  └─────┘                                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Component Breakdown

### 1. Workers (API Gateway)
- **Runtime:** Cloudflare Workers (V8 isolates)
- **Framework:** Hono (lightweight, fast)
- **Handles:** REST API, auth, routing to other services

### 2. D1 (SQLite - Metadata)
- User accounts
- Game/project registry  
- API keys
- Usage tracking

### 3. KV (Player Saves)
- Key: `{game_id}:{player_id}:{save_key}`
- Value: JSON blob (up to 25MB)
- Fast reads, eventually consistent
- Perfect for game saves

### 4. Durable Objects (Rooms)
- One DO instance per room
- Holds WebSocket connections
- Manages room state (players, metadata)
- Handles broadcast/relay
- Auto-hibernates when empty

### 5. R2 (Game Storage)
- Static game files (HTML, JS, assets)
- Served via Workers or custom domain
- S3-compatible API

## API Endpoints

### Saves API
```
POST /v1/saves/:key     — Save data
GET  /v1/saves/:key     — Load data
DELETE /v1/saves/:key   — Delete save
GET  /v1/saves          — List save keys
```

### Rooms API
```
POST /v1/rooms              — Create room (returns code)
GET  /v1/rooms/:code        — Get room info
POST /v1/rooms/:code/join   — Join room
WS   /v1/rooms/:code/ws     — WebSocket connection
```

### Games API (v2)
```
POST /v1/games              — Create game project
POST /v1/games/:id/upload   — Upload game files
GET  /v1/games/:id          — Get game info/URL
```

## Authentication

### Player Auth (Anonymous)
- Auto-generated player ID (stored in localStorage)
- Passed via `X-Player-ID` header
- No signup required for basic saves

### Developer Auth (API Key)
- API key in `Authorization: Bearer <key>`
- Required for game management
- Tied to Supabase user account

## Data Flow

### Save Flow
```
Client → Worker → KV.put(game:player:key, data)
```

### Room Join Flow
```
Client → Worker → lookup room code in D1
                → get Durable Object stub
                → DO.fetch(/join)
                → return room state
```

### WebSocket Flow
```
Client ←──WebSocket──→ Durable Object (Room)
                            │
                            ├── broadcast to all
                            ├── send to specific player
                            └── receive from any player
```

## Durable Object: GameRoom

```typescript
class GameRoom {
  state: DurableObjectState
  sessions: Map<string, WebSocket>  // playerId → socket
  
  // HTTP handlers
  async fetch(request: Request)
  
  // Room operations  
  async join(playerId: string, ws: WebSocket)
  async leave(playerId: string)
  async broadcast(message: any, exclude?: string)
  async sendTo(playerId: string, message: any)
  
  // State
  async getPlayers(): Player[]
  async getRoomInfo(): RoomInfo
}
```

## Rate Limits (Free Tier Reference)

| Resource | Free Limit |
|----------|------------|
| Worker requests | 100K/day |
| KV reads | 100K/day |
| KV writes | 1K/day |
| D1 reads | 5M/day |
| D1 writes | 100K/day |
| DO requests | 1M/mo |
| R2 storage | 10GB |

## Project Structure

```
watchtower-api/
├── src/
│   ├── index.ts          # Main worker entry
│   ├── routes/
│   │   ├── saves.ts      # /v1/saves/*
│   │   ├── rooms.ts      # /v1/rooms/*
│   │   └── games.ts      # /v1/games/*
│   ├── durable-objects/
│   │   └── GameRoom.ts   # Room DO class
│   ├── middleware/
│   │   └── auth.ts       # API key / player ID
│   └── utils/
│       └── codes.ts      # Room code generation
├── wrangler.toml
├── package.json
└── tsconfig.json
```

## Next Steps

1. [x] Project structure
2. [ ] Create D1 database
3. [ ] Create KV namespace
4. [ ] Create R2 bucket
5. [ ] Implement saves API
6. [ ] Implement rooms API (DO)
7. [ ] Deploy and test
8. [ ] Build SDK
