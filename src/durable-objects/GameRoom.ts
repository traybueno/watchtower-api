interface Player {
  id: string
  joinedAt: number
}

interface RoomState {
  gameId: string
  hostId: string
  createdAt: number
  players: Map<string, Player>
}

interface Session {
  playerId: string
  ws: WebSocket
}

export class GameRoom {
  private state: DurableObjectState
  private sessions: Map<string, Session> = new Map()
  private roomState: RoomState | null = null

  constructor(state: DurableObjectState) {
    this.state = state
    
    // Restore state on wake
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<RoomState>('roomState')
      if (stored) {
        this.roomState = {
          ...stored,
          players: new Map(Object.entries(stored.players || {}))
        }
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // Handle WebSocket upgrade
    if (path === '/ws') {
      return this.handleWebSocket(request, url)
    }

    // HTTP routes
    if (path === '/create' && request.method === 'POST') {
      return this.handleCreate(request)
    }
    
    if (path === '/info' && request.method === 'GET') {
      return this.handleInfo()
    }
    
    if (path === '/join' && request.method === 'POST') {
      return this.handleJoin(request)
    }

    return new Response('Not found', { status: 404 })
  }

  private async handleCreate(request: Request): Promise<Response> {
    if (this.roomState) {
      return Response.json({ success: false, error: 'Room already exists' }, { status: 400 })
    }

    const { gameId, hostId } = await request.json() as { gameId: string; hostId: string }
    
    this.roomState = {
      gameId,
      hostId,
      createdAt: Date.now(),
      players: new Map([[hostId, { id: hostId, joinedAt: Date.now() }]])
    }
    
    await this.saveState()
    
    return Response.json({ success: true })
  }

  private async handleInfo(): Promise<Response> {
    if (!this.roomState) {
      return new Response('Room not found', { status: 404 })
    }

    return Response.json({
      gameId: this.roomState.gameId,
      hostId: this.roomState.hostId,
      createdAt: this.roomState.createdAt,
      playerCount: this.roomState.players.size,
      players: Array.from(this.roomState.players.values())
    })
  }

  private async handleJoin(request: Request): Promise<Response> {
    if (!this.roomState) {
      return new Response('Room not found', { status: 404 })
    }

    const { playerId } = await request.json() as { playerId: string }
    
    if (!this.roomState.players.has(playerId)) {
      this.roomState.players.set(playerId, { id: playerId, joinedAt: Date.now() })
      await this.saveState()
      
      // Broadcast player joined
      this.broadcast({
        type: 'player_joined',
        playerId,
        playerCount: this.roomState.players.size
      }, playerId)
    }

    return Response.json({
      success: true,
      gameId: this.roomState.gameId,
      hostId: this.roomState.hostId,
      players: Array.from(this.roomState.players.values())
    })
  }

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    if (!this.roomState) {
      return new Response('Room not found', { status: 404 })
    }

    const playerId = url.searchParams.get('playerId')
    if (!playerId) {
      return new Response('playerId required', { status: 400 })
    }

    // Create WebSocket pair
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Accept and set up server socket
    this.state.acceptWebSocket(server, [playerId])
    
    // Track session
    this.sessions.set(playerId, { playerId, ws: server })
    
    // Ensure player is in room
    if (!this.roomState.players.has(playerId)) {
      this.roomState.players.set(playerId, { id: playerId, joinedAt: Date.now() })
      await this.saveState()
    }

    // Send welcome message
    server.send(JSON.stringify({
      type: 'connected',
      playerId,
      room: {
        gameId: this.roomState.gameId,
        hostId: this.roomState.hostId,
        players: Array.from(this.roomState.players.values())
      }
    }))

    // Broadcast join to others
    this.broadcast({
      type: 'player_joined',
      playerId,
      playerCount: this.roomState.players.size
    }, playerId)

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const tags = this.state.getTags(ws)
    const playerId = tags[0]
    
    if (!playerId || !this.roomState) return

    try {
      const data = JSON.parse(message as string)
      
      // Handle different message types
      switch (data.type) {
        case 'broadcast':
          // Broadcast to all players (including sender unless excluded)
          this.broadcast({
            type: 'message',
            from: playerId,
            data: data.data
          }, data.excludeSelf ? playerId : undefined)
          break
          
        case 'send':
          // Send to specific player
          if (data.to) {
            this.sendTo(data.to, {
              type: 'message',
              from: playerId,
              data: data.data
            })
          }
          break
          
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
          break
          
        default:
          // Pass through as broadcast
          this.broadcast({
            type: 'message',
            from: playerId,
            data
          }, playerId)
      }
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e)
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const tags = this.state.getTags(ws)
    const playerId = tags[0]
    
    if (playerId && this.roomState) {
      this.sessions.delete(playerId)
      this.roomState.players.delete(playerId)
      await this.saveState()
      
      // Broadcast player left
      this.broadcast({
        type: 'player_left',
        playerId,
        playerCount: this.roomState.players.size
      })
      
      // If room is empty, clean up (optional: add timeout)
      if (this.roomState.players.size === 0) {
        await this.state.storage.deleteAll()
        this.roomState = null
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error('WebSocket error:', error)
    ws.close(1011, 'Internal error')
  }

  private broadcast(message: object, excludePlayerId?: string) {
    const json = JSON.stringify(message)
    for (const [playerId, session] of this.sessions) {
      if (playerId !== excludePlayerId) {
        try {
          session.ws.send(json)
        } catch (e) {
          // Socket closed, clean up
          this.sessions.delete(playerId)
        }
      }
    }
  }

  private sendTo(playerId: string, message: object) {
    const session = this.sessions.get(playerId)
    if (session) {
      try {
        session.ws.send(JSON.stringify(message))
      } catch (e) {
        this.sessions.delete(playerId)
      }
    }
  }

  private async saveState() {
    if (this.roomState) {
      await this.state.storage.put('roomState', {
        ...this.roomState,
        players: Object.fromEntries(this.roomState.players)
      })
    }
  }
}
