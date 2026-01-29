import { Hono } from 'hono'
import type { Env } from '../index'

export const savesRouter = new Hono<{ Bindings: Env }>()

// Auth middleware handles playerId/gameId validation and sets them in context

// Helper to build KV key
function buildKey(gameId: string, playerId: string, saveKey: string): string {
  return `${gameId}:${playerId}:${saveKey}`
}

// GET /v1/saves — List all save keys for player
savesRouter.get('/', async (c) => {
  const playerId = c.get('playerId' as never) as string
  const gameId = c.get('gameId' as never) as string
  const prefix = `${gameId}:${playerId}:`
  
  const list = await c.env.SAVES.list({ prefix })
  const keys = list.keys.map(k => k.name.replace(prefix, ''))
  
  return c.json({ keys })
})

// GET /v1/saves/:key — Load a save
savesRouter.get('/:key', async (c) => {
  const playerId = c.get('playerId' as never) as string
  const gameId = c.get('gameId' as never) as string
  const saveKey = c.req.param('key')
  
  const key = buildKey(gameId, playerId, saveKey)
  const data = await c.env.SAVES.get(key, 'json')
  
  if (data === null) {
    return c.json({ error: 'Save not found' }, 404)
  }
  
  return c.json({ key: saveKey, data })
})

// POST /v1/saves/:key — Create or update a save
savesRouter.post('/:key', async (c) => {
  const playerId = c.get('playerId' as never) as string
  const gameId = c.get('gameId' as never) as string
  const saveKey = c.req.param('key')
  
  let data: unknown
  try {
    data = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  
  const key = buildKey(gameId, playerId, saveKey)
  await c.env.SAVES.put(key, JSON.stringify(data))
  
  return c.json({ success: true, key: saveKey })
})

// DELETE /v1/saves/:key — Delete a save
savesRouter.delete('/:key', async (c) => {
  const playerId = c.get('playerId' as never) as string
  const gameId = c.get('gameId' as never) as string
  const saveKey = c.req.param('key')
  
  const key = buildKey(gameId, playerId, saveKey)
  await c.env.SAVES.delete(key)
  
  return c.json({ success: true })
})
