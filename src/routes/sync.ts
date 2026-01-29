import { Hono } from 'hono'
import type { Env } from '../index'

export const syncRouter = new Hono<{ Bindings: Env }>()

// Helper to get sync room DO stub
function getSyncStub(env: Env, roomId: string, gameId: string): DurableObjectStub {
  // Namespace by gameId to isolate games
  const id = env.SYNC_ROOMS.idFromName(`${gameId}:${roomId}`)
  return env.SYNC_ROOMS.get(id)
}

// GET /v1/sync/rooms — List public rooms for a game
syncRouter.get('/rooms', async (c) => {
  const gameId = c.get('gameId' as never) as string || c.req.query('gameId')
  
  if (!gameId) {
    return c.json({ error: 'gameId required' }, 400)
  }
  
  // TODO: Implement room listing via KV or D1
  // For now, return empty array
  return c.json({ rooms: [] })
})

// GET /v1/sync/:roomId/ws — WebSocket connection for sync
syncRouter.get('/:roomId/ws', async (c) => {
  const roomId = c.req.param('roomId')
  const playerId = c.get('playerId' as never) as string || c.req.query('playerId')
  const gameId = c.get('gameId' as never) as string || c.req.query('gameId')
  
  if (!playerId) {
    return c.json({ error: 'playerId required' }, 400)
  }
  
  if (!gameId) {
    return c.json({ error: 'gameId required' }, 400)
  }
  
  // Check for WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade')
  if (upgradeHeader !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426)
  }
  
  // Forward to Durable Object
  const stub = getSyncStub(c.env, roomId, gameId)
  const url = new URL(c.req.url)
  url.pathname = '/ws'
  url.searchParams.set('playerId', playerId)
  
  // Pass create/maxPlayers/public options
  const create = c.req.query('create')
  const maxPlayers = c.req.query('maxPlayers')
  const isPublic = c.req.query('public')
  const metadata = c.req.query('metadata')
  
  if (create) url.searchParams.set('create', create)
  if (maxPlayers) url.searchParams.set('maxPlayers', maxPlayers)
  if (isPublic) url.searchParams.set('public', isPublic)
  if (metadata) url.searchParams.set('metadata', metadata)
  
  return stub.fetch(new Request(url.toString(), {
    headers: c.req.raw.headers
  }))
})
