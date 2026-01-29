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
  // Auth middleware sets these from API key validation
  const gameId = c.get('gameId' as never) as string
  const playerId = c.get('playerId' as never) as string
  
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
  const playerId = c.get('playerId' as never) as string
  
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
  // Auth middleware sets playerId, but also check query param for WebSocket URL compatibility
  const playerId = c.get('playerId' as never) as string || c.req.query('playerId')
  
  if (!playerId) {
    return c.json({ error: 'playerId required' }, 400)
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
