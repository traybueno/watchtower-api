import { Hono } from 'hono'
import type { Env } from '../index'
import { internalAuthMiddleware } from '../middleware/auth'

export const internalRouter = new Hono<{ Bindings: Env }>()

// All internal routes require internal secret
internalRouter.use('*', internalAuthMiddleware)

interface KeyData {
  gameId: string
  projectId: string
  createdAt: number
}

/**
 * POST /internal/keys - Register an API key
 * Called by dashboard when creating/regenerating keys
 */
internalRouter.post('/keys', async (c) => {
  const { apiKey, gameId, projectId } = await c.req.json() as {
    apiKey: string
    gameId: string
    projectId: string
  }
  
  if (!apiKey?.startsWith('wt_')) {
    return c.json({ error: 'Invalid API key format' }, 400)
  }
  
  if (!gameId || !projectId) {
    return c.json({ error: 'gameId and projectId required' }, 400)
  }
  
  const keyData: KeyData = {
    gameId,
    projectId,
    createdAt: Date.now()
  }
  
  await c.env.SAVES.put(`apikey:${apiKey}`, JSON.stringify(keyData))
  
  return c.json({ success: true })
})

/**
 * DELETE /internal/keys/:apiKey - Revoke an API key
 * Called by dashboard when deleting projects or regenerating keys
 */
internalRouter.delete('/keys/:apiKey', async (c) => {
  const apiKey = c.req.param('apiKey')
  
  if (!apiKey?.startsWith('wt_')) {
    return c.json({ error: 'Invalid API key format' }, 400)
  }
  
  await c.env.SAVES.delete(`apikey:${apiKey}`)
  
  return c.json({ success: true })
})

/**
 * GET /internal/keys/:apiKey - Check if key exists (for debugging)
 */
internalRouter.get('/keys/:apiKey', async (c) => {
  const apiKey = c.req.param('apiKey')
  
  const keyData = await c.env.SAVES.get(`apikey:${apiKey}`, 'json') as KeyData | null
  
  if (!keyData) {
    return c.json({ exists: false })
  }
  
  return c.json({ exists: true, ...keyData })
})
