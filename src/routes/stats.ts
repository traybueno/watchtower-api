import { Hono } from 'hono'
import type { Env } from '../index'

export const statsRouter = new Hono<{ Bindings: Env }>()

// Key format for stats in KV
const STATS_KEY_PREFIX = 'stats:'

// GET /v1/stats — Get game stats (for SDK and dashboard)
statsRouter.get('/', async (c) => {
  const gameId = c.get('gameId' as never) as string
  
  // Get stats from KV (or return zeros if none exist yet)
  const statsKey = `${STATS_KEY_PREFIX}${gameId}`
  const stored = await c.env.SAVES.get(statsKey, 'json') as Record<string, number> | null
  
  const stats = stored || {}
  
  return c.json({
    online: stats.online || 0,
    today: stats.today || 0,
    monthly: stats.monthly || 0,
    total: stats.total || 0,
    rooms: stats.rooms || 0,
    inRooms: stats.inRooms || 0,
    avgSession: stats.avgSession || 0,
    avgRoomSize: stats.avgRoomSize || 0,
    updatedAt: stats.updatedAt || null
  })
})

// POST /v1/stats/track — Track an event (called by SDK on connect/disconnect)
statsRouter.post('/track', async (c) => {
  const gameId = c.get('gameId' as never) as string
  const playerId = c.get('playerId' as never) as string
  const body = await c.req.json() as { event: string }
  
  const statsKey = `${STATS_KEY_PREFIX}${gameId}`
  const playerKey = `${STATS_KEY_PREFIX}${gameId}:player:${playerId}`
  const dailyKey = `${STATS_KEY_PREFIX}${gameId}:daily:${new Date().toISOString().split('T')[0]}`
  const monthlyKey = `${STATS_KEY_PREFIX}${gameId}:monthly:${new Date().toISOString().slice(0, 7)}`
  
  // Get current stats
  const stored = await c.env.SAVES.get(statsKey, 'json') as Record<string, number> | null
  const stats = stored || { online: 0, today: 0, monthly: 0, total: 0, rooms: 0, inRooms: 0 }
  
  // Get daily unique players
  const dailyPlayers = await c.env.SAVES.get(dailyKey, 'json') as string[] | null || []
  const monthlyPlayers = await c.env.SAVES.get(monthlyKey, 'json') as string[] | null || []
  
  // Check if this player is new today/this month/ever
  const isNewToday = !dailyPlayers.includes(playerId)
  const isNewThisMonth = !monthlyPlayers.includes(playerId)
  const playerData = await c.env.SAVES.get(playerKey, 'json') as Record<string, unknown> | null
  const isNewPlayer = !playerData
  
  switch (body.event) {
    case 'session_start':
      stats.online = (stats.online || 0) + 1
      
      // Track unique players
      if (isNewToday) {
        dailyPlayers.push(playerId)
        stats.today = dailyPlayers.length
        await c.env.SAVES.put(dailyKey, JSON.stringify(dailyPlayers), { expirationTtl: 86400 * 2 })
      }
      if (isNewThisMonth) {
        monthlyPlayers.push(playerId)
        stats.monthly = monthlyPlayers.length
        await c.env.SAVES.put(monthlyKey, JSON.stringify(monthlyPlayers), { expirationTtl: 86400 * 35 })
      }
      if (isNewPlayer) {
        stats.total = (stats.total || 0) + 1
      }
      
      // Update player record
      await c.env.SAVES.put(playerKey, JSON.stringify({
        firstSeen: playerData?.firstSeen || new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        sessions: ((playerData?.sessions as number) || 0) + 1
      }))
      break
      
    case 'session_end':
      stats.online = Math.max(0, (stats.online || 0) - 1)
      break
      
    case 'room_join':
      stats.inRooms = (stats.inRooms || 0) + 1
      break
      
    case 'room_leave':
      stats.inRooms = Math.max(0, (stats.inRooms || 0) - 1)
      break
      
    case 'room_create':
      stats.rooms = (stats.rooms || 0) + 1
      break
      
    case 'room_close':
      stats.rooms = Math.max(0, (stats.rooms || 0) - 1)
      break
  }
  
  stats.updatedAt = Date.now()
  await c.env.SAVES.put(statsKey, JSON.stringify(stats))
  
  return c.json({ success: true })
})

// GET /v1/stats/player — Get current player's stats
statsRouter.get('/player', async (c) => {
  const gameId = c.get('gameId' as never) as string
  const playerId = c.get('playerId' as never) as string
  
  const playerKey = `${STATS_KEY_PREFIX}${gameId}:player:${playerId}`
  const playerData = await c.env.SAVES.get(playerKey, 'json') as Record<string, unknown> | null
  
  if (!playerData) {
    return c.json({
      firstSeen: null,
      lastSeen: null,
      sessions: 0,
      playtime: 0
    })
  }
  
  return c.json({
    firstSeen: playerData.firstSeen,
    lastSeen: playerData.lastSeen,
    sessions: playerData.sessions || 0,
    playtime: playerData.playtime || 0
  })
})
