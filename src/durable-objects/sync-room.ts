/**
 * SyncRoom Durable Object
 * 
 * A lightweight room for automatic state synchronization.
 * Much simpler than the full Room DO - just broadcasts state updates.
 * 
 * Features:
 * - Server timestamps on all messages (for client interpolation)
 * - Tick-based sequencing (for ordering)
 * - Player count broadcasting
 * - Late-joiner full state sync
 */

interface PlayerConnection {
  ws: WebSocket
  playerId: string
  state: Record<string, unknown>
  joinedAt: number
  lastTick: number
}

export class SyncRoom {
  private state: DurableObjectState
  private players: Map<WebSocket, PlayerConnection> = new Map()
  private playerStates: Map<string, Record<string, unknown>> = new Map()
  private tick: number = 0  // Server tick counter for ordering

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ws') {
      return this.handleWebSocket(request, url)
    }

    return new Response('Not found', { status: 404 })
  }

  private handleWebSocket(request: Request, url: URL): Response {
    const playerId = url.searchParams.get('playerId')
    if (!playerId) {
      return new Response('playerId required', { status: 400 })
    }

    // Check for existing connection from this player
    for (const [ws, conn] of this.players) {
      if (conn.playerId === playerId) {
        // Close old connection
        try {
          ws.close(1000, 'Replaced by new connection')
        } catch {}
        this.players.delete(ws)
      }
    }

    // Create WebSocket pair
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Accept the WebSocket
    server.accept()

    // Store connection
    const connection: PlayerConnection = {
      ws: server,
      playerId,
      state: {},
      joinedAt: Date.now(),
      lastTick: this.tick
    }
    this.players.set(server, connection)

    // Send current state to new player (late joiner sync)
    const fullState: Record<string, Record<string, unknown>> = {}
    for (const [id, state] of this.playerStates) {
      if (id !== playerId) {
        fullState[id] = state
      }
    }
    
    // Always send welcome message with server info
    server.send(JSON.stringify({
      type: 'welcome',
      playerId,
      tick: this.tick,
      serverTime: Date.now(),
      playerCount: this.players.size,
      state: Object.keys(fullState).length > 0 ? fullState : undefined
    }))

    // Notify others about new player
    this.broadcast({
      type: 'join',
      playerId,
      playerCount: this.players.size,
      tick: this.tick,
      serverTime: Date.now()
    }, server)

    // Handle messages
    server.addEventListener('message', (event) => {
      this.handleMessage(server, event.data as string)
    })

    // Handle close
    server.addEventListener('close', () => {
      this.handleClose(server)
    })

    server.addEventListener('error', () => {
      this.handleClose(server)
    })

    return new Response(null, {
      status: 101,
      webSocket: client
    })
  }

  private handleMessage(ws: WebSocket, data: string) {
    const connection = this.players.get(ws)
    if (!connection) return

    try {
      const message = JSON.parse(data)

      switch (message.type) {
        case 'state':
          // Player state update
          this.tick++  // Increment server tick
          connection.state = message.data
          connection.lastTick = this.tick
          this.playerStates.set(connection.playerId, message.data)
          
          // Broadcast to others with server timestamp for interpolation
          this.broadcast({
            type: 'state',
            playerId: connection.playerId,
            data: message.data,
            tick: this.tick,
            serverTime: Date.now()
          }, ws)
          break

        case 'ping':
          ws.send(JSON.stringify({ 
            type: 'pong', 
            time: Date.now(),
            tick: this.tick,
            playerCount: this.players.size
          }))
          break

        case 'broadcast':
          this.broadcast({
            type: 'message',
            from: connection.playerId,
            data: message.data,
            tick: this.tick,
            serverTime: Date.now()
          }, ws)
          break
      }
    } catch (e) {
      console.error('Error handling sync message:', e)
    }
  }

  private handleClose(ws: WebSocket) {
    const connection = this.players.get(ws)
    if (!connection) return

    const { playerId } = connection

    // Remove from maps
    this.players.delete(ws)
    this.playerStates.delete(playerId)

    // Notify others with updated player count
    this.broadcast({
      type: 'leave',
      playerId,
      playerCount: this.players.size,
      tick: this.tick,
      serverTime: Date.now()
    })
  }

  private broadcast(message: unknown, exclude?: WebSocket) {
    const data = JSON.stringify(message)
    
    for (const [ws] of this.players) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data)
        } catch (e) {
          // Connection might be closing
        }
      }
    }
  }
}
