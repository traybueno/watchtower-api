/**
 * Connect Routes - Simple room connections
 * 
 * Simplified API for multiplayer rooms. No auth required.
 * Room is created on first connection if it doesn't exist.
 * 
 * CCU Tracking: If CCU_COUNTERS is configured and X-Game-ID is provided,
 * connections are tracked against the game owner's CCU limit.
 */

import { Hono } from 'hono'
import type { Env } from '../index'

export const connectRouter = new Hono<{ Bindings: Env }>()

// Plan-based CCU limits
const CCU_LIMITS: Record<string, number> = {
  free: 10,
  pro: 1000,
  scale: 10000,
}

// Helper to get Room DO stub by code
function getRoomStub(env: Env, roomCode: string): DurableObjectStub {
  const id = env.SIMPLE_ROOMS.idFromName(roomCode.toUpperCase())
  return env.SIMPLE_ROOMS.get(id)
}

// Helper to get CCU Counter DO stub by user_id
function getCCUCounterStub(env: Env, userId: string): DurableObjectStub | null {
  if (!env.CCU_COUNTERS) return null
  const id = env.CCU_COUNTERS.idFromName(userId)
  return env.CCU_COUNTERS.get(id)
}

interface ProjectInfo {
  userId: string
  projectId: string
  projectName: string
  plan: string
  userEmail: string
}

// Look up user_id, project info, and plan from gameId
async function getProjectFromGameId(env: Env, gameId: string): Promise<ProjectInfo | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null
  
  try {
    // Get project by game_id with user email via join
    const projectRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/projects?game_id=eq.${encodeURIComponent(gameId)}&select=id,name,user_id`,
      {
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    )
    
    if (!projectRes.ok) return null
    
    const projects = await projectRes.json() as Array<{ id: string; name: string; user_id: string }>
    if (projects.length === 0) return null
    
    const project = projects[0]
    const userId = project.user_id
    
    // Get user email from auth.users via admin API
    let userEmail = ''
    try {
      const authRes = await fetch(
        `${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
        {
          headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      )
      if (authRes.ok) {
        const userData = await authRes.json() as { email?: string }
        userEmail = userData.email || ''
      }
    } catch {}
    
    // Get user's plan
    const subRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=plan,status`,
      {
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    )
    
    let plan = 'free'
    if (subRes.ok) {
      const subs = await subRes.json() as Array<{ plan: string; status: string }>
      const sub = subs[0]
      if (sub && sub.status !== 'canceled') {
        plan = sub.plan || 'free'
      }
    }
    
    return { 
      userId, 
      projectId: project.id,
      projectName: project.name,
      plan,
      userEmail 
    }
  } catch (e) {
    console.error('Error looking up project from gameId:', e)
    return null
  }
}

// Backwards compat wrapper
async function getUserFromGameId(env: Env, gameId: string): Promise<{ userId: string; plan: string } | null> {
  const info = await getProjectFromGameId(env, gameId)
  if (!info) return null
  return { userId: info.userId, plan: info.plan }
}

// GET /v1/connect/:roomId/ws — WebSocket connection
// This is the main entry point. Room is auto-created if it doesn't exist.
connectRouter.get('/:roomId/ws', async (c) => {
  const roomId = c.req.param('roomId').toUpperCase()
  const playerId = c.req.query('playerId')
  const gameId = c.req.header('X-Game-ID') || c.req.query('gameId')
  
  if (!playerId) {
    return c.json({ error: 'playerId required' }, 400)
  }

  if (!gameId) {
    return c.json({ error: 'gameId required. Pass X-Game-ID header or gameId query param.' }, 400)
  }

  // Check for WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade')
  if (upgradeHeader !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426)
  }

  // Rate limiting via KV (per-IP: 10/min, per-gameId: 100/min)
  const clientIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
  const now = Math.floor(Date.now() / 60000) // minute bucket

  const ipKey = `rl:ip:${clientIp}:${now}`
  const gameKey = `rl:game:${gameId}:${now}`

  const [ipCount, gameCount] = await Promise.all([
    c.env.SAVES.get(ipKey).then(v => parseInt(v || '0', 10)),
    c.env.SAVES.get(gameKey).then(v => parseInt(v || '0', 10)),
  ])

  if (ipCount >= 10) {
    return c.json({ error: 'Rate limit exceeded (per-IP: 10 connections/min)', code: 'RATE_LIMIT' }, 429)
  }
  if (gameCount >= 100) {
    return c.json({ error: 'Rate limit exceeded (per-game: 100 connections/min)', code: 'RATE_LIMIT' }, 429)
  }

  // Increment counters (fire-and-forget, 120s TTL to cover the minute window)
  c.executionCtx.waitUntil(Promise.all([
    c.env.SAVES.put(ipKey, String(ipCount + 1), { expirationTtl: 120 }),
    c.env.SAVES.put(gameKey, String(gameCount + 1), { expirationTtl: 120 }),
  ]))

  // CCU check (if gameId provided and CCU_COUNTERS configured)
  let ccuConnectionId: string | null = null
  let ccuCounterStub: DurableObjectStub | null = null
  
  if (gameId && c.env.CCU_COUNTERS) {
    const userInfo = await getUserFromGameId(c.env, gameId)
    
    if (userInfo) {
      ccuCounterStub = getCCUCounterStub(c.env, userInfo.userId)
      
      if (ccuCounterStub) {
        // Ensure limit is set
        const limit = CCU_LIMITS[userInfo.plan] || CCU_LIMITS.free
        await ccuCounterStub.fetch(new Request('http://internal/set-limit', {
          method: 'POST',
          body: JSON.stringify({ limit, plan: userInfo.plan })
        }))
        
        // Try to connect
        ccuConnectionId = `${roomId}:${playerId}`
        const ccuRes = await ccuCounterStub.fetch(new Request('http://internal/connect', {
          method: 'POST',
          body: JSON.stringify({
            connectionId: ccuConnectionId,
            projectId: gameId,
            roomId,
            playerId
          })
        }))
        
        const ccuData = await ccuRes.json() as { allowed: boolean; error?: string; code?: string; currentCCU?: number; limit?: number }
        
        if (!ccuData.allowed) {
          // Fire notification (non-blocking)
          const projectInfo = await getProjectFromGameId(c.env, gameId)
          if (projectInfo) {
            // Call limits endpoint to record event and send notification
            fetch(`https://watchtower-api.watchtower-host.workers.dev/v1/limits/event`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userId: projectInfo.userId,
                projectId: projectInfo.projectId,
                gameId,
                gameName: projectInfo.projectName,
                plan: projectInfo.plan,
                currentCCU: ccuData.currentCCU || ccuData.limit,
                limit: ccuData.limit || CCU_LIMITS[projectInfo.plan] || 10,
                userEmail: projectInfo.userEmail,
              })
            }).catch(() => {}) // Fire and forget
          }
          
          return c.json({
            error: ccuData.error || 'CCU limit reached',
            code: ccuData.code || 'CCU_LIMIT'
          }, 429)
        }
      }
    }
  }
  
  // Forward to Durable Object (room created on first connection)
  const stub = getRoomStub(c.env, roomId)
  const url = new URL(c.req.url)
  url.pathname = '/ws'
  
  // Pass roomId to the Room DO so it can track CCU cleanup
  url.searchParams.set('roomId', roomId)
  
  // Add CCU tracking info to the request so Room can clean up on disconnect
  if (ccuConnectionId && ccuCounterStub) {
    // Store in KV for the Room to use on disconnect
    // Key format: ccu:{roomId}:{playerId} = userId
    const userInfo = await getUserFromGameId(c.env, gameId!)
    if (userInfo) {
      await c.env.SAVES.put(`ccu:${roomId}:${playerId}`, userInfo.userId, { expirationTtl: 86400 })
    }
  }
  
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
