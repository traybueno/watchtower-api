import { Context, Next } from 'hono'
import type { Env } from '../index'

interface ApiKeyData {
  gameId: string
  projectId: string
  createdAt: number
}

// Cache for API key lookups (in-memory, per-isolate)
const keyCache = new Map<string, { data: ApiKeyData; expires: number }>()
const CACHE_TTL = 60 * 1000 // 1 minute

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
  
  // Check in-memory cache first
  const cached = keyCache.get(apiKey)
  if (cached && cached.expires > Date.now()) {
    c.set('gameId' as never, cached.data.gameId)
    c.set('projectId' as never, cached.data.projectId)
    c.set('playerId' as never, playerId)
    c.set('apiKey' as never, apiKey)
    return next()
  }
  
  // Try KV first (fast path for existing keys)
  let keyData = await c.env.SAVES.get(`apikey:${apiKey}`, 'json') as ApiKeyData | null
  
  // If not in KV, check Supabase directly
  if (!keyData && c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const response = await fetch(
        `${c.env.SUPABASE_URL}/rest/v1/projects?api_key=eq.${encodeURIComponent(apiKey)}&select=id,game_id`,
        {
          headers: {
            'apikey': c.env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      )
      
      if (response.ok) {
        const projects = await response.json() as Array<{ id: string; game_id: string }>
        if (projects.length > 0) {
          keyData = {
            gameId: projects[0].game_id,
            projectId: projects[0].id,
            createdAt: Date.now()
          }
          
          // Store in KV for future fast lookups (fire and forget)
          c.env.SAVES.put(`apikey:${apiKey}`, JSON.stringify(keyData)).catch(() => {})
        }
      }
    } catch (e) {
      console.error('Supabase lookup failed:', e)
    }
  }
  
  if (!keyData) {
    return c.json({ error: 'Invalid API key' }, 401)
  }
  
  // Cache in memory
  keyCache.set(apiKey, { data: keyData, expires: Date.now() + CACHE_TTL })
  
  // Set context for downstream handlers
  c.set('gameId' as never, keyData.gameId)
  c.set('projectId' as never, keyData.projectId)
  c.set('playerId' as never, playerId)
  c.set('apiKey' as never, apiKey)
  
  await next()
}
