import { Context, Next } from 'hono'
import type { Env } from '../index'

interface ApiKeyData {
  gameId: string
  projectId: string
  createdAt: number
}

/**
 * Auth middleware - validates API key and sets gameId
 * 
 * Expects: Authorization: Bearer wt_live_xxx OR ?apiKey=wt_... (for WebSocket)
 * Sets: c.gameId, c.projectId, c.playerId
 */
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization')
  const playerId = c.req.header('X-Player-ID') || c.req.query('playerId')
  
  if (!playerId) {
    return c.json({ error: 'X-Player-ID header required' }, 400)
  }
  
  // Try Authorization header first, fall back to query param (for WebSocket)
  let apiKey: string | undefined
  if (authHeader?.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7)
  } else {
    apiKey = c.req.query('apiKey')
  }
  
  if (!apiKey) {
    return c.json({ error: 'Authorization header or apiKey query param required' }, 401)
  }
  
  if (!apiKey.startsWith('wt_')) {
    return c.json({ error: 'Invalid API key format' }, 401)
  }
  
  // Look up API key in KV
  const keyData = await c.env.SAVES.get(`apikey:${apiKey}`, 'json') as ApiKeyData | null
  
  if (!keyData) {
    return c.json({ error: 'Invalid API key' }, 401)
  }
  
  // Set context for downstream handlers
  c.set('gameId' as never, keyData.gameId)
  c.set('projectId' as never, keyData.projectId)
  c.set('playerId' as never, playerId)
  c.set('apiKey' as never, apiKey)
  
  await next()
}

/**
 * Internal auth - for dashboard to manage keys
 * Uses a shared secret (INTERNAL_SECRET env var)
 */
export async function internalAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization')
  
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization required' }, 401)
  }
  
  const secret = authHeader.slice(7)
  
  // Check against internal secret
  if (secret !== c.env.INTERNAL_SECRET) {
    return c.json({ error: 'Invalid internal secret' }, 401)
  }
  
  await next()
}
