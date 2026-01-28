import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { savesRouter } from './routes/saves'
import { roomsRouter } from './routes/rooms'
import { GameRoom } from './durable-objects/GameRoom'

export { GameRoom }

export interface Env {
  DB: D1Database
  SAVES: KVNamespace
  ROOMS: DurableObjectNamespace
  ENVIRONMENT: string
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

// API routes
app.route('/v1/saves', savesRouter)
app.route('/v1/rooms', roomsRouter)

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
