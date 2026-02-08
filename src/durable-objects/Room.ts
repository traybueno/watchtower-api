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
 * - Event history (ring buffer of last 50 events)
 * - Player kick (host only)
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

interface HistoryEvent {
  type: string
  serverTime: number
  tick: number
  [key: string]: unknown
}

const MAX_HISTORY_EVENTS = 50

export class Room {
  private state: DurableObjectState
  private connections: Map<WebSocket, Connection> = new Map()
  private players: Map<string, Player> = new Map()
  private hostId: string = ''
  private tick: number = 0
  private eventHistory: HistoryEvent[] = []

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

  private addToHistory(event: HistoryEvent) {
    this.eventHistory.push(event)
    if (this.eventHistory.length > MAX_HISTORY_EVENTS) {
      this.eventHistory.shift()
    }
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

    // Send welcome message with recent events
    server.send(JSON.stringify({
      type: 'welcome',
      playerId,
      hostId: this.hostId,
      players: Array.from(this.players.values()),
      recentEvents: this.eventHistory,
      tick: this.tick,
      serverTime: Date.now()
    }))

    // Create join event
    const joinEvent: HistoryEvent = {
      type: 'join',
      playerId,
      name,
      meta,
      joinedAt: player.joinedAt,
      playerCount: this.players.size,
      tick: this.tick,
      serverTime: Date.now()
    }

    // Add to history
    this.addToHistory(joinEvent)

    // Notify others
    this.broadcast(joinEvent, server)

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
        case 'broadcast': {
          const msgEvent: HistoryEvent = {
            type: 'message',
            from: conn.player.id,
            data: msg.data,
            tick: this.tick,
            serverTime: Date.now()
          }
          // Add to history
          this.addToHistory(msgEvent)
          // Send to everyone except sender
          this.broadcast(msgEvent, ws)
          break
        }

        case 'direct':
          // Send to specific player (not added to history)
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

        case 'kick':
          // Only host can kick
          if (conn.player.id !== this.hostId) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Only the host can kick players',
              tick: this.tick,
              serverTime: Date.now()
            }))
            break
          }

          const targetId = msg.playerId
          const reason = msg.reason

          // Find and close the target's connection
          for (const [targetWs, targetConn] of this.connections) {
            if (targetConn.player.id === targetId) {
              const kickEvent: HistoryEvent = {
                type: 'kicked',
                playerId: targetId,
                reason,
                tick: this.tick,
                serverTime: Date.now()
              }

              // Add to history
              this.addToHistory(kickEvent)

              // Tell the kicked player first
              try {
                targetWs.send(JSON.stringify(kickEvent))
              } catch {}

              // Broadcast to everyone else
              this.broadcast(kickEvent, targetWs)

              // Remove from tracking
              this.connections.delete(targetWs)
              this.players.delete(targetId)

              // Close connection
              try {
                targetWs.close(1000, reason || 'Kicked by host')
              } catch {}

              // Reassign host if kicked player was host (shouldn't happen, but safety)
              if (this.hostId === targetId) {
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

              break
            }
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

    // Create leave event
    const leaveEvent: HistoryEvent = {
      type: 'leave',
      playerId: player.id,
      playerCount: this.players.size,
      tick: this.tick,
      serverTime: Date.now()
    }

    // Add to history
    this.addToHistory(leaveEvent)

    // Notify others
    this.broadcast(leaveEvent)
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
