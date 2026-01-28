# Watchtower — Project Status

> **Last Updated:** 2026-01-28  
> **Ed's Quick Reference** — Always read this first when working on Watchtower

---

## 🚀 What's Live

### API (Cloudflare Workers)
- **URL:** https://watchtower-api.watchtower-host.workers.dev/
- **Subdomain:** watchtower-host.workers.dev
- **Account ID:** f683ff16449a42773d744b6dc4f5099d

### Endpoints Working
```
GET  /                      → Health check
POST /v1/saves/:key         → Save data (requires X-Player-ID, X-Game-ID)
GET  /v1/saves/:key         → Load data
GET  /v1/saves              → List saves
DELETE /v1/saves/:key       → Delete save
POST /v1/rooms              → Create room (returns 4-letter code)
GET  /v1/rooms/:code        → Room info
POST /v1/rooms/:code/join   → Join room
WS   /v1/rooms/:code/ws     → WebSocket connection
```

### Sites
| Site | URL | Platform |
|------|-----|----------|
| Landing Page | https://watchtower.host | Netlify |
| Test Playground | https://watchtower-test-playground.netlify.app | Netlify |

---

## 🏗️ Infrastructure

### Cloudflare Resources
| Resource | Name | ID |
|----------|------|-----|
| Worker | watchtower-api | — |
| D1 Database | watchtower-db | `48370393-26b8-4482-a007-ce5ccd7f0139` |
| KV Namespace | SAVES | `ace14130d77a43879e2eb3a5c20ac9d0` |
| Durable Object | GameRoom | (managed) |
| R2 Bucket | — | Not created yet (need to enable in dashboard) |

### Other Services
| Service | Details |
|---------|---------|
| Supabase | Project: watchtower-api, URL: https://pnqewixndboyxooxpibg.supabase.co |
| Domain | watchtower.host (GoDaddy → Netlify) |
| Netlify | Team: Honor Thy Error, CLI authenticated |

---

## 📁 Project Locations

```
~/clawd/projects/
├── watchtower-api/          # Cloudflare Worker (this project)
│   ├── src/
│   │   ├── index.ts         # Hono app entry
│   │   ├── routes/saves.ts  # /v1/saves/* 
│   │   ├── routes/rooms.ts  # /v1/rooms/*
│   │   └── durable-objects/GameRoom.ts
│   ├── wrangler.toml
│   ├── ARCHITECTURE.md      # Full technical docs
│   └── STATUS.md            # This file
├── watchtower-sdk/          # @watchtower/sdk npm package ✅ NEW
│   ├── src/index.ts         # Main SDK code
│   ├── dist/                # Built output
│   └── README.md            # Usage docs
├── watchtower-site/         # Landing page (Next.js)
└── watchtower-test/         # Test playground (static HTML)
```

---

## ✅ Validated (2026-01-28)

- [x] Cloud saves work (KV) — saved "tomato", retrieved it
- [x] Room creation — generates 4-letter codes
- [x] Room joining — multiple devices in same room
- [x] WebSocket relay — real-time position sync
- [x] Chat broadcast — messages between clients
- [x] Player join/leave events — notifications work
- [x] Durable Objects hibernation — cost-efficient scaling

---

## ❌ Not Built Yet

### High Priority (MVP)
- [ ] **SDK package** ← BUILDING NOW
- [ ] **Dashboard + Auth** ← NEXT (Option B)
- [ ] **R2 Game Hosting** ← AFTER THAT (Option C)
- [ ] D1 schema for users/games/keys
- [ ] Rate limiting

### Medium Priority
- [ ] R2 game hosting (drag folder → get URL)
- [ ] SDK packages (@watchtower/sdk for JS)
- [ ] Room settings (max players, private rooms)
- [ ] Better error handling

### Lower Priority
- [ ] Unity SDK
- [ ] Godot SDK
- [ ] Custom domains for games
- [ ] Billing (Stripe)
- [ ] Usage analytics

---

## 🔧 Dev Commands

```bash
cd ~/clawd/projects/watchtower-api

# Local dev
npm run dev

# Deploy to production
npm run deploy

# View logs
npm run tail

# Check KV data
wrangler kv key list --namespace-id=ace14130d77a43879e2eb3a5c20ac9d0 --remote

# Deploy test playground
cd ~/clawd/projects/watchtower-test && netlify deploy --prod --dir=.
```

---

## 🧠 Key Decisions Made

1. **Cloudflare over Fly.io/Railway** — Edge-native, Durable Objects perfect for rooms
2. **Hono over Express** — Lightweight, edge-first framework
3. **KV for saves** — Simple key-value, global replication
4. **Durable Objects for rooms** — Strong consistency, WebSocket hibernation
5. **Anonymous player IDs (for now)** — Client provides ID, no auth yet
6. **4-letter room codes** — Easy to share verbally

---

## 📝 Changelog

### 2026-01-28
- Initial API deployed to Cloudflare Workers
- Cloud saves (KV) working
- Multiplayer rooms (Durable Objects) working
- WebSocket relay working
- Test playground created and validated
- Landing page live at watchtower.host
- **SDK built** (`@watchtower/sdk`) — ready for npm publish
