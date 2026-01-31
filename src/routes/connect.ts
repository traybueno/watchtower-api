/**
 * Connect Routes - Simple room connections
 * 
 * This is the new simplified API. Just connect to a room and go.
 * Room is created on first connection if it doesn't exist.
 */

import { Hono } from 'hono'
import type { Env } from '../index'

export const connectRouter = new Hono<{ Bindings: Env }>()

// Helper to get Room DO stub by code
function getRoomStub(env: Env, roomCode: string): DurableObjectStub {
  const id = env.SIMPLE_ROOMS.idFromName(roomCode.toUpperCase())
  return env.SIMPLE_ROOMS.get(id)
}

// GET /v1/connect/:roomId/ws — WebSocket connection
// This is the main entry point. Room is auto-created if it doesn't exist.
connectRouter.get('/:roomId/ws', async (c) => {
  const roomId = c.req.param('roomId').toUpperCase()
  const playerId = c.req.query('playerId')
  
  if (!playerId) {
    return c.json({ error: 'playerId required' }, 400)
  }
  
  // Check for WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade')
  if (upgradeHeader !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426)
  }
  
  // Forward to Durable Object (room created on first connection)
  const stub = getRoomStub(c.env, roomId)
  const url = new URL(c.req.url)
  url.pathname = '/ws'
  
  // Forward all query params (playerId, name, meta, etc)
  return stub.fetch(new Request(url.toString(), {
    headers: c.req.raw.headers
  }))
})

// GET /v1/connect/:roomId — Get room info (HTTP)
connectRouter.get('/:roomId', async (c) => {
  const roomId = c.req.param('roomId').toUpperCase()
  
  const stub = getRoomStub(c.env, roomId)
  const response = await stub.fetch(new Request('http://internal/info'))
  
  const data = await response.json()
  return c.json(data)
})
