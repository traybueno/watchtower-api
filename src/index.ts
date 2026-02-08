import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { hostingRouter } from './routes/hosting'
import { connectRouter } from './routes/connect'
import { authMiddleware } from './middleware/auth'
import { Room } from './durable-objects/Room'

// Only export Room (the one we actually use)
export { Room }

export interface Env {
  SAVES: KVNamespace
  SIMPLE_ROOMS: DurableObjectNamespace
  GAMES?: R2Bucket
  ENVIRONMENT: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
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
    version: '1.0.0',
    status: 'ok',
    docs: 'https://watchtower.host/docs'
  })
})

// Multiplayer rooms (no auth required - uses gameId from SDK)
app.route('/v1/connect', connectRouter)

// Hosting API (requires API key)
app.use('/v1/hosting/*', authMiddleware)
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
