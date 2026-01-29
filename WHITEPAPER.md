# Watchtower Technical Whitepaper

> **Version:** 0.2.0  
> **Last Updated:** January 28, 2026  
> **Status:** Private Beta

---

## Executive Summary

Watchtower is a managed backend platform for indie game developers. It provides cloud saves, multiplayer rooms, and real-time WebSocket relay through a simple SDK — no server management, no DevOps, no infrastructure headaches.

**Target Audience:** Solo developers and small studios shipping games who don't want to learn Kubernetes, manage databases, or read 50-page docs.

**Core Principle:** Four features. Flat pricing. Ship this week.

---

## Platform Architecture

### Infrastructure Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Edge Network** | Cloudflare Workers | Global API gateway (~0ms cold start) |
| **Real-time State** | Durable Objects | WebSocket connections, room state, host migration |
| **Key-Value Storage** | Cloudflare KV | Cloud saves (global replication, <50ms reads) |
| **Relational Data** | Cloudflare D1 | Projects, API keys, usage tracking |
| **Static Hosting** | Cloudflare R2 | Game file hosting (planned v1) |
| **Authentication** | Supabase Auth | Developer dashboard login (GitHub OAuth) |
| **Dashboard** | Next.js 15 | Project management UI |

### Architecture Diagram

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
│                      │  │  Room C   │  │  │ projects,    │                │
│                      │  └───────────┘  │  │  api_keys    │                │
│                      └─────────────────┘  └──────────────┘                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Features

### 1. Cloud Saves

**Technology:** Cloudflare KV (globally replicated key-value store)

Simple per-player key-value storage. No schema, no migrations, no database administration.

**Key Format:**
```
{game_id}:{player_id}:{save_key} → JSON blob
```

**Characteristics:**
- **Latency:** <50ms reads globally
- **Replication:** Automatic global distribution
- **Limits:** 25MB per value
- **Consistency:** Eventually consistent (suitable for game saves)

**SDK Usage:**
```typescript
// Save anything JSON-serializable
await wt.save('progress', { level: 5, coins: 100 })
await wt.save('settings', { music: true, sfx: true })

// Load it back
const progress = await wt.load('progress')

// List all save keys
const keys = await wt.listSaves() // ['progress', 'settings']

// Delete a save
await wt.deleteSave('progress')
```

**API Endpoints:**
```
POST   /v1/saves/:key    # Save data
GET    /v1/saves/:key    # Load data
GET    /v1/saves         # List keys
DELETE /v1/saves/:key    # Delete save
```

---

### 2. Multiplayer Rooms

**Technology:** Cloudflare Durable Objects (single-threaded stateful compute)

Create rooms with 4-letter codes. Share with friends to play together. Automatic host migration when the host disconnects.

**Why Durable Objects:**
- **Strong consistency:** All players in a room talk to the same instance
- **WebSocket hibernation:** Near-zero cost when idle
- **Automatic scaling:** 0 instances when no rooms → millions when needed
- **State persistence:** Room state survives disconnections

**Room Lifecycle:**
```
1. Host creates room → receives "ABCD" code
2. Players join via code → WebSocket upgrade
3. Players exchange messages → DO broadcasts
4. Host leaves → automatic migration to longest-tenured player
5. Last player leaves → room cleaned up, DO hibernates
```

**SDK Usage:**
```typescript
// Create a room (you become the host)
const room = await wt.createRoom()
console.log('Room code:', room.code) // "ABCD"

// Join an existing room
const room = await wt.joinRoom('ABCD')

// Room properties
room.isHost      // true if you're the host
room.hostId      // current host's player ID
room.playerId    // your player ID
room.playerCount // number of connected players
room.players     // all players' states
```

**API Endpoints:**
```
POST   /v1/rooms              # Create room
GET    /v1/rooms/:code        # Get room info
POST   /v1/rooms/:code/join   # Join via HTTP
GET    /v1/rooms/:code/ws     # Join via WebSocket
```

---

### 3. Real-time State Sync

**Technology:** WebSocket relay at 20Hz with Durable Object hibernation

Three layers of state synchronization:

#### Player State (Automatic Sync)
Each player's position, animation, health, etc. Automatically broadcast at 20Hz.

```typescript
// Set your player state (automatically synced)
room.player.set({
  x: 100, y: 200,
  sprite: 'running',
  health: 100
})

// State is merged — update individual fields
room.player.set({ x: 150 }) // keeps y, sprite, health

// Listen for other players' states
room.on('players', (players) => {
  for (const [playerId, state] of Object.entries(players)) {
    updateOtherPlayer(playerId, state.x, state.y)
  }
})
```

#### Game State (Host-Controlled)
Shared state for game phase, scores, round number. Only the host can modify.

```typescript
// Host sets game state
if (room.isHost) {
  room.state.set({
    phase: 'lobby',
    round: 0,
    scores: {}
  })
}

// Everyone receives state updates
room.on('state', (state) => {
  if (state.phase === 'playing') startGame()
})
```

#### Broadcast Messages (One-off Events)
For events that don't need persistent state (explosions, chat, etc.)

```typescript
// Broadcast to all players
room.broadcast({ type: 'explosion', x: 50, y: 50 })

// Send to specific player
room.sendTo(playerId, { type: 'private', text: 'hey' })

// Receive messages
room.on('message', (from, data) => {
  if (data.type === 'explosion') createExplosion(data.x, data.y)
})
```

---

### 4. WebSocket Protocol

**Client → Server Messages:**
```json
// Update player state
{"type": "player_state", "state": {"x": 100, "y": 200}}

// Update game state (host only)
{"type": "game_state", "state": {"phase": "playing"}}

// Broadcast to all
{"type": "broadcast", "data": {...}, "excludeSelf": true}

// Send to specific player
{"type": "send", "to": "player_id", "data": {...}}

// Transfer host
{"type": "transfer_host", "newHostId": "player_id"}

// Keep-alive
{"type": "ping"}
```

**Server → Client Messages:**
```json
// Connection established
{"type": "connected", "playerId": "...", "room": {...}, 
 "playerStates": {...}, "gameState": {...}}

// Player state updates (20Hz batch)
{"type": "players_sync", "players": {...}}

// Individual player update (immediate)
{"type": "player_state_update", "playerId": "...", "state": {...}}

// Game state update
{"type": "game_state_sync", "state": {...}}

// Player joined
{"type": "player_joined", "playerId": "...", "playerCount": 3}

// Player left
{"type": "player_left", "playerId": "...", "playerCount": 2}

// Host changed
{"type": "host_changed", "hostId": "..."}

// Broadcast message
{"type": "message", "from": "player_id", "data": {...}}

// Pong response
{"type": "pong", "timestamp": 1234567890}
```

---

## Developer Dashboard

**Technology:** Next.js 15 + Supabase Auth + Tailwind CSS

### Features

- **GitHub OAuth Login** — No passwords, no email verification
- **Project Management** — Create, view, delete projects
- **API Key Management** — Generate, view, regenerate keys
- **Quick Start Guide** — Inline code examples

### Database Schema

```sql
-- Projects table
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  name TEXT NOT NULL,
  game_id TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'free',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Usage tracking (prepared for billing)
CREATE TABLE usage (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  date DATE NOT NULL,
  saves_count INTEGER DEFAULT 0,
  loads_count INTEGER DEFAULT 0,
  rooms_created INTEGER DEFAULT 0,
  ws_messages INTEGER DEFAULT 0,
  UNIQUE(project_id, date)
);
```

### Row-Level Security
All data protected by Supabase RLS — users can only access their own projects.

---

## SDK Package

**Package:** `@watchtower/sdk`  
**Size:** ~15KB minified  
**Dependencies:** None (pure TypeScript)

### Initialization
```typescript
import { Watchtower } from '@watchtower/sdk'

const wt = new Watchtower({
  gameId: 'my-game',
  apiKey: 'wt_live_...',
  playerId: 'optional-custom-id', // auto-generated if omitted
  apiUrl: 'https://watchtower-api.watchtower-host.workers.dev'
})
```

### Full Example: Multiplayer Game
```typescript
import { Watchtower } from '@watchtower/sdk'

const wt = new Watchtower({ gameId: 'my-game', apiKey: 'wt_...' })

async function joinGame(code?: string) {
  const room = code 
    ? await wt.joinRoom(code)
    : await wt.createRoom()
  
  console.log('Room:', room.code)
  
  // Game loop - update player position
  function gameLoop() {
    room.player.set({
      x: myPlayer.x,
      y: myPlayer.y,
      animation: myPlayer.currentAnim
    })
    requestAnimationFrame(gameLoop)
  }
  gameLoop()
  
  // Render other players
  room.on('players', (players) => {
    for (const [id, state] of Object.entries(players)) {
      if (id !== room.playerId) {
        updateOtherPlayer(id, state.x, state.y)
      }
    }
  })
  
  // Host manages game state
  room.on('playerJoined', (_, count) => {
    if (room.isHost && count >= 2) {
      room.state.set({ phase: 'playing', round: 1 })
    }
  })
  
  return room
}
```

---

## Platform Compatibility

### SDK (Saves + Multiplayer)

| Engine | Support | Notes |
|--------|---------|-------|
| **Unity** | ✅ Planned | C# SDK coming |
| **Godot** | ✅ Planned | GDScript SDK coming |
| **Unreal** | ✅ Planned | C++ SDK coming |
| **Web/JS** | ✅ Ready | TypeScript SDK available |
| **Defold** | ✅ Via HTTP | Lua via REST/WebSocket |
| **Any Engine** | ✅ | If it has HTTP + WebSocket |

### Game Hosting (Planned v1)

Web games only:
- Phaser
- Three.js  
- PixiJS
- Godot HTML5 export
- Unity WebGL export

---

## Scaling Characteristics

| Component | Model | Free Tier Limits |
|-----------|-------|------------------|
| **Workers** | Per-request auto-scale | 100K requests/day |
| **KV** | Global replication | 100K reads/day, 1K writes/day |
| **D1** | Single region + replicas | 5M reads/day, 100K writes/day |
| **Durable Objects** | Per-room instance | 1M requests/month |
| **R2** | Object storage | 10GB storage |

**Key insight:** Durable Objects scale horizontally by room. 1000 active rooms = 1000 isolated instances, each handling only its players.

---

## Pricing Model (Planned)

| Tier | Price | Games | Players/mo | Storage | Messages/day |
|------|-------|-------|------------|---------|--------------|
| **Free** | $0 | 3 | 100 | 100MB | 1K |
| **Hobby** | $10/mo | 10 | 1,000 | 10GB | 10K |
| **Indie** | $25/mo | Unlimited | 10,000 | 50GB | 100K |
| **Studio** | $50/mo | Unlimited | 50,000 | 200GB | Unlimited |

All plans include 14-day free trial. No credit card required.

---

## Security Model

### Current (Beta)
- API keys for game identification
- Player IDs client-provided (anonymous/pseudonymous)
- Rate limiting via Cloudflare's built-in protection
- TLS encryption on all endpoints

### Planned (v1)
- API key validation on all requests
- JWT-based player authentication (optional)
- Per-game rate limiting with configurable quotas
- Request signing for sensitive operations
- Webhook notifications for events

---

## Competitive Positioning

| Platform | Strengths | Weaknesses | Watchtower Difference |
|----------|-----------|------------|----------------------|
| **PlayFab** | Full-featured, enterprise-ready | Complex, expensive, overkill for indies | Simple, 4 features only |
| **Firebase** | Well-documented, flexible | Not game-oriented, pricing surprises | Game-focused, flat pricing |
| **Nakama** | Open source, full-featured | Self-hosting required | Zero infrastructure |
| **Photon** | Industry standard multiplayer | Pricing per CCU, complex setup | Room-based, simpler model |
| **GameSparks** | Full BaaS | Acquired by Amazon, uncertain future | Indie-focused, active development |

---

## Roadmap

### v0.1 ✅ (Complete)
- [x] Cloud saves (KV)
- [x] Room create/join/leave
- [x] WebSocket relay with hibernation
- [x] Player state sync at 20Hz
- [x] Game state (host-controlled)
- [x] Host migration
- [x] TypeScript SDK

### v0.2 ✅ (Complete)
- [x] Supabase Auth integration
- [x] Developer dashboard
- [x] Project management
- [x] API key generation

### v0.3 (In Progress)
- [ ] API key validation in Workers
- [ ] Usage tracking (D1)
- [ ] Rate limiting per project
- [ ] SDK v1 publish to npm

### v1.0 (Planned)
- [ ] R2 game hosting
- [ ] Custom domains
- [ ] Stripe billing
- [ ] Unity/Godot SDKs
- [ ] Dashboard analytics

---

## Deployment

### API (Cloudflare Workers)
```
Live URL: https://watchtower-api.watchtower-host.workers.dev
```

### Dashboard (Vercel)
```
Live URL: https://watchtower.host
```

### Repository Structure
```
watchtower-api/      # Cloudflare Workers + Durable Objects
watchtower-site/     # Next.js dashboard
watchtower-sdk/      # TypeScript SDK
```

---

## Contact

- **Website:** https://watchtower.host
- **Docs:** https://docs.watchtower.host (coming soon)
- **Discord:** (coming soon)
- **Email:** hello@watchtower.host

---

*Built for developers who want to ship games, not manage servers.*
