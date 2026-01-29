import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { savesRouter } from './routes/saves'
import { roomsRouter } from './routes/rooms'
import { syncRouter } from './routes/sync'
import { statsRouter } from './routes/stats'
import { hostingRouter } from './routes/hosting'
import { internalRouter } from './routes/internal'
import { authMiddleware } from './middleware/auth'
import { GameRoom } from './durable-objects/GameRoom'
import { SyncRoom } from './durable-objects/sync-room'

export { GameRoom, SyncRoom }

export interface Env {
  DB: D1Database
  SAVES: KVNamespace
  ROOMS: DurableObjectNamespace
  SYNC_ROOMS: DurableObjectNamespace
  GAMES?: R2Bucket  // Optional until R2 is enabled
  ENVIRONMENT: string
  INTERNAL_SECRET: string
}

const app = new Hono<{ Bindings: Env }>()

// CORS for game clients
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Player-ID', 'X-Game-ID'],
}))

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'Watchtower API',
    version: '0.1.0',
    status: 'ok',
    docs: 'https://watchtower.host/docs'
  })
})

// Internal routes (dashboard → API)
app.route('/internal', internalRouter)

// Public API routes (require API key auth)
app.use('/v1/*', authMiddleware)
app.route('/v1/saves', savesRouter)
app.route('/v1/rooms', roomsRouter)
app.route('/v1/sync', syncRouter)
app.route('/v1/stats', statsRouter)
app.route('/v1/hosting', hostingRouter)

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404)
})

// Error handler
app.onError((err, c) => {
  console.error('Error:', err)
  return c.json({ error: 'Internal server error' }, 500)
})

export default app
