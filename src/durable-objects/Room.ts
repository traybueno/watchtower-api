/**
 * Room Durable Object
 * 
 * Simple multiplayer room - routes messages, tracks players, assigns host.
 * No opinions on game logic. Server is a dumb pipe with metadata.
 * 
 * Features:
 * - WebSocket connections
 * - Broadcast to all players
 * - Direct messages between players  
 * - Player tracking with metadata
 * - Auto host assignment
 * - Server timestamps + ticks for ordering
 */

interface Player {
  id: string
  name?: string
  meta?: Record<string, unknown>
  joinedAt: number
}

interface Connection {
  ws: WebSocket
  player: Player
}

export class Room {
  private state: DurableObjectState
  private connections: Map<WebSocket, Connection> = new Map()
  private players: Map<string, Player> = new Map()
  private hostId: string = ''
  private tick: number = 0

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ws') {
      return this.handleWebSocket(request, url)
    }

    if (url.pathname === '/info') {
      return Response.json({
        playerCount: this.players.size,
        players: Array.from(this.players.values()),
        hostId: this.hostId
      })
    }

    return new Response('Not found', { status: 404 })
  }

  private handleWebSocket(request: Request, url: URL): Response {
    const playerId = url.searchParams.get('playerId')
    if (!playerId) {
      return new Response('playerId required', { status: 400 })
    }

    const name = url.searchParams.get('name') || undefined
    const metaStr = url.searchParams.get('meta')
    const meta = metaStr ? JSON.parse(metaStr) : undefined

    // Handle reconnection - close old connection
    for (const [ws, conn] of this.connections) {
      if (conn.player.id === playerId) {
        try {
          ws.close(1000, 'Replaced by new connection')
        } catch {}
        this.connections.delete(ws)
      }
    }

    // Create WebSocket pair
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()

    // Create player
    const player: Player = {
      id: playerId,
      name,
      meta,
      joinedAt: Date.now()
    }

    // Store connection
    this.connections.set(server, { ws: server, player })
    this.players.set(playerId, player)

    // Assign host if needed
    if (!this.hostId || !this.players.has(this.hostId)) {
      this.hostId = playerId
    }

    // Send welcome message
    server.send(JSON.stringify({
      type: 'welcome',
      playerId,
      hostId: this.hostId,
      players: Array.from(this.players.values()),
      tick: this.tick,
      serverTime: Date.now()
    }))

    // Notify others
    this.broadcast({
      type: 'join',
      playerId,
      name,
      meta,
      joinedAt: player.joinedAt,
      playerCount: this.players.size,
      tick: this.tick,
      serverTime: Date.now()
    }, server)

    // Handle messages
    server.addEventListener('message', (event) => {
      this.handleMessage(server, event.data as string)
    })

    // Handle disconnect
    server.addEventListener('close', () => this.handleClose(server))
    server.addEventListener('error', () => this.handleClose(server))

    return new Response(null, { status: 101, webSocket: client })
  }

  private handleMessage(ws: WebSocket, data: string) {
    const conn = this.connections.get(ws)
    if (!conn) return

    try {
      const msg = JSON.parse(data)
      this.tick++

      switch (msg.type) {
        case 'broadcast':
          // Send to everyone except sender
          this.broadcast({
            type: 'message',
            from: conn.player.id,
            data: msg.data,
            tick: this.tick,
            serverTime: Date.now()
          }, ws)
          break

        case 'direct':
          // Send to specific player
          if (msg.to) {
            this.sendTo(msg.to, {
              type: 'direct',
              from: conn.player.id,
              data: msg.data,
              tick: this.tick,
              serverTime: Date.now()
            })
          }
          break

        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            tick: this.tick,
            serverTime: Date.now(),
            playerCount: this.players.size
          }))
          break
      }
    } catch (e) {
      console.error('Error handling message:', e)
    }
  }

  private handleClose(ws: WebSocket) {
    const conn = this.connections.get(ws)
    if (!conn) return

    const { player } = conn
    this.connections.delete(ws)
    this.players.delete(player.id)

    // Reassign host if needed
    if (this.hostId === player.id) {
      const firstPlayer = this.players.keys().next().value
      this.hostId = firstPlayer || ''
      
      if (this.hostId) {
        this.broadcast({
          type: 'host_changed',
          hostId: this.hostId,
          tick: this.tick,
          serverTime: Date.now()
        })
      }
    }

    // Notify others
    this.broadcast({
      type: 'leave',
      playerId: player.id,
      playerCount: this.players.size,
      tick: this.tick,
      serverTime: Date.now()
    })
  }

  private broadcast(message: unknown, exclude?: WebSocket) {
    const data = JSON.stringify(message)
    for (const [ws] of this.connections) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data)
        } catch {}
      }
    }
  }

  private sendTo(playerId: string, message: unknown) {
    for (const [ws, conn] of this.connections) {
      if (conn.player.id === playerId && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(message))
        } catch {}
        break
      }
    }
  }
}
