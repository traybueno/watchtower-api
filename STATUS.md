# Watchtower — Project Status

> **Last Updated:** 2026-01-29  
> **Ed's Quick Reference** — Always read this first when working on Watchtower

---

## 🚀 What's Live

### API (Cloudflare Workers)
- **URL:** https://watchtower-api.watchtower-host.workers.dev/
- **Status:** ✅ Production

### Endpoints
```
# Health
GET  /                      → Health check + version

# Cloud Saves
POST /v1/saves/:key         → Save data
GET  /v1/saves/:key         → Load data
GET  /v1/saves              → List saves
DELETE /v1/saves/:key       → Delete save

# Multiplayer Rooms
POST /v1/rooms              → Create room (returns 4-letter code)
GET  /v1/rooms/:code        → Room info
POST /v1/rooms/:code/join   → Join room
WS   /v1/rooms/:code/ws     → WebSocket connection

# Analytics (NEW)
GET  /v1/stats              → Game-wide stats (online, DAU, MAU, rooms, etc.)
POST /v1/stats/track        → Track events (session_start/end, room_join/leave)
GET  /v1/stats/player       → Current player's stats

# Internal (Dashboard → API)
POST /internal/keys         → Register API key
DELETE /internal/keys/:key  → Revoke API key
GET  /internal/keys/:key    → Check key exists
```

### Sites
| Site | URL | Platform |
|------|-----|----------|
| Main Site | https://watchtower.host | Netlify (Next.js) |
| Dashboard | https://watchtower.host/dashboard | Netlify (Next.js) |
| Docs | https://watchtower.host/docs | Netlify (Next.js) |

---

## 📦 SDK (@watchtower/sdk)

**Status:** ✅ Built, tested, ready

```javascript
import { Watchtower } from '@watchtower/sdk'

const wt = new Watchtower({ gameId: 'my-game', apiKey: 'wt_...' })

// Cloud Saves
await wt.save('progress', { level: 5 })
const data = await wt.load('progress')

// Multiplayer
const room = await wt.createRoom()
await wt.joinRoom('ABCD')

// Analytics (NEW)
const stats = await wt.getStats()       // { online, today, monthly, total, rooms... }
const me = await wt.getPlayerStats()    // { firstSeen, sessions, playtime }
await wt.trackSessionStart()
```

---

## 🏗️ Infrastructure

### Cloudflare Resources
| Resource | Name | Notes |
|----------|------|-------|
| Worker | watchtower-api | Main API |
| D1 Database | watchtower-db | Users/projects (via Supabase for now) |
| KV Namespace | SAVES | Game saves + stats + API keys |
| Durable Object | GameRoom | Real-time multiplayer rooms |

### Other Services
| Service | Purpose |
|---------|---------|
| Supabase | Auth + project/user database |
| Netlify | Site hosting |
| GoDaddy | Domain (watchtower.host) |

---

## 💰 Pricing Tiers

| Tier | Price | Games | MAU | Storage | Hosting |
|------|-------|-------|-----|---------|---------|
| Free | $0 | 1 | 50 | 100MB | Auto URL (abc123.watchtower.host) |
| Hobby | $10 | 10 | 1,000 | 10GB | Custom subdomain |
| Indie | $25 | ∞ | 10,000 | 50GB | Custom domain |
| Studio | $50 | ∞ | 50,000 | 200GB | + Team accounts |

---

## ✅ What Works (Validated)

- [x] Cloud saves (KV-backed)
- [x] Room creation (4-letter codes)
- [x] Room joining + WebSocket relay
- [x] Player state sync (20Hz)
- [x] Game state (host-controlled)
- [x] Broadcast messages
- [x] Host migration
- [x] SDK (JS/TS)
- [x] Dashboard with live stats
- [x] Stats API (online, DAU, MAU, rooms)
- [x] Auth flow (Supabase)
- [x] Project creation/management

---

## ❌ Not Built Yet

### Next Up
- [ ] **Web game hosting** ← NEXT (drag folder → get URL)
- [ ] R2 bucket for game files
- [ ] Subdomain routing for hosted games

### Medium Priority
- [ ] Billing (Stripe)
- [ ] Usage enforcement (rate limits)
- [ ] Unity SDK wrapper
- [ ] Godot SDK wrapper

### Lower Priority
- [ ] Custom domains for games
- [ ] Room settings (max players, private)
- [ ] Leaderboards (maybe)

---

## 🔧 Dev Commands

```bash
# API
cd ~/clawd/projects/watchtower-api
npm run dev        # Local dev
npx wrangler deploy  # Deploy to prod
npx wrangler tail  # View logs

# Site
cd ~/clawd/projects/watchtower-site
npm run dev        # Local dev
npx netlify deploy --prod  # Deploy to prod

# SDK
cd ~/clawd/projects/watchtower-sdk
npm run build      # Build SDK
node test-stats.mjs  # Test stats API
```

---

## 📝 Recent Changes

### 2026-01-29
- **Performance fix:** Middleware no longer checks auth on public pages (3-5x faster)
- **Stats API:** Added `/v1/stats`, `/v1/stats/track`, `/v1/stats/player`
- **SDK:** Added `getStats()`, `getPlayerStats()`, `trackSessionStart/End()`
- **Dashboard:** Live stats cards (fetches from API every 30s)
- **Pricing:** Added free tier, web hosting at all tiers
- **Color scheme:** Changed from amber to emerald green
- **About page:** Created with story, how it works, infrastructure

### 2026-01-28
- Initial API deployed
- Cloud saves + multiplayer rooms working
- Landing page + dashboard live
- SDK built and tested
