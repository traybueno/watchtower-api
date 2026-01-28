import { Hono } from 'hono'
import type { Env } from '../index'
import { generateRoomCode } from '../utils/codes'

export const roomsRouter = new Hono<{ Bindings: Env }>()

// Helper to get room DO stub by code
function getRoomStub(env: Env, roomCode: string): DurableObjectStub {
  const id = env.ROOMS.idFromName(roomCode.toUpperCase())
  return env.ROOMS.get(id)
}

// POST /v1/rooms — Create a new room
roomsRouter.post('/', async (c) => {
  const gameId = c.req.header('X-Game-ID')
  const playerId = c.req.header('X-Player-ID')
  
  if (!gameId || !playerId) {
    return c.json({ error: 'X-Game-ID and X-Player-ID headers required' }, 400)
  }
  
  // Generate unique room code
  const roomCode = generateRoomCode()
  
  // Get DO stub and initialize room
  const stub = getRoomStub(c.env, roomCode)
  const response = await stub.fetch(new Request('http://internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId, hostId: playerId })
  }))
  
  const data = await response.json() as { success: boolean }
  if (!data.success) {
    return c.json({ error: 'Failed to create room' }, 500)
  }
  
  return c.json({ 
    code: roomCode,
    wsUrl: `wss://watchtower-api.${c.env.ENVIRONMENT === 'production' ? 'workers.dev' : 'dev'}/v1/rooms/${roomCode}/ws`
  })
})

// GET /v1/rooms/:code — Get room info
roomsRouter.get('/:code', async (c) => {
  const roomCode = c.req.param('code').toUpperCase()
  
  const stub = getRoomStub(c.env, roomCode)
  const response = await stub.fetch(new Request('http://internal/info'))
  
  if (response.status === 404) {
    return c.json({ error: 'Room not found' }, 404)
  }
  
  const data = await response.json()
  return c.json(data)
})

// POST /v1/rooms/:code/join — Join a room (HTTP, for initial join)
roomsRouter.post('/:code/join', async (c) => {
  const roomCode = c.req.param('code').toUpperCase()
  const playerId = c.req.header('X-Player-ID')
  
  if (!playerId) {
    return c.json({ error: 'X-Player-ID header required' }, 400)
  }
  
  const stub = getRoomStub(c.env, roomCode)
  const response = await stub.fetch(new Request('http://internal/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId })
  }))
  
  if (response.status === 404) {
    return c.json({ error: 'Room not found' }, 404)
  }
  
  const data = await response.json()
  return c.json(data)
})

// GET /v1/rooms/:code/ws — WebSocket upgrade
roomsRouter.get('/:code/ws', async (c) => {
  const roomCode = c.req.param('code').toUpperCase()
  const playerId = c.req.header('X-Player-ID') || c.req.query('playerId')
  
  if (!playerId) {
    return c.json({ error: 'X-Player-ID header or playerId query param required' }, 400)
  }
  
  // Check for WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade')
  if (upgradeHeader !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426)
  }
  
  // Forward to Durable Object
  const stub = getRoomStub(c.env, roomCode)
  const url = new URL(c.req.url)
  url.pathname = '/ws'
  url.searchParams.set('playerId', playerId)
  
  return stub.fetch(new Request(url.toString(), {
    headers: c.req.raw.headers
  }))
})
