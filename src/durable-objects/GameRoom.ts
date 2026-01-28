interface Player {
  id: string
  joinedAt: number
}

interface RoomState {
  gameId: string
  hostId: string
  createdAt: number
  players: Record<string, Player>
}

export class GameRoom {
  private state: DurableObjectState
  private roomState: RoomState | null = null

  constructor(state: DurableObjectState) {
    this.state = state
    
    // Restore state on wake
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<RoomState>('roomState')
      if (stored) {
        this.roomState = stored
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
      players: { [hostId]: { id: hostId, joinedAt: Date.now() } }
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
      playerCount: Object.keys(this.roomState.players).length,
      players: Object.values(this.roomState.players)
    })
  }

  private async handleJoin(request: Request): Promise<Response> {
    if (!this.roomState) {
      return new Response('Room not found', { status: 404 })
    }

    const { playerId } = await request.json() as { playerId: string }
    
    if (!this.roomState.players[playerId]) {
      this.roomState.players[playerId] = { id: playerId, joinedAt: Date.now() }
      await this.saveState()
      
      // Broadcast player joined to WebSocket clients
      this.broadcast({
        type: 'player_joined',
        playerId,
        playerCount: Object.keys(this.roomState.players).length
      }, playerId)
    }

    return Response.json({
      success: true,
      gameId: this.roomState.gameId,
      hostId: this.roomState.hostId,
      players: Object.values(this.roomState.players)
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

    // Accept with hibernation API - tag with playerId
    this.state.acceptWebSocket(server, [playerId])
    
    // Ensure player is in room state
    if (!this.roomState.players[playerId]) {
      this.roomState.players[playerId] = { id: playerId, joinedAt: Date.now() }
      await this.saveState()
    }

    // Send welcome message immediately
    server.send(JSON.stringify({
      type: 'connected',
      playerId,
      room: {
        gameId: this.roomState.gameId,
        hostId: this.roomState.hostId,
        players: Object.values(this.roomState.players)
      }
    }))

    // Broadcast join to others
    this.broadcast({
      type: 'player_joined',
      playerId,
      playerCount: Object.keys(this.roomState.players).length
    }, playerId)

    return new Response(null, { status: 101, webSocket: client })
  }

  // Called by Cloudflare when a WebSocket message is received
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const tags = this.state.getTags(ws)
    const playerId = tags[0]
    
    if (!playerId || !this.roomState) return

    try {
      const data = JSON.parse(message as string)
      
      switch (data.type) {
        case 'broadcast':
          // Broadcast to all players
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
          // Unknown type - broadcast as message
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

  // Called by Cloudflare when a WebSocket closes
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const tags = this.state.getTags(ws)
    const playerId = tags[0]
    
    if (playerId && this.roomState) {
      delete this.roomState.players[playerId]
      await this.saveState()
      
      // Broadcast player left
      this.broadcast({
        type: 'player_left',
        playerId,
        playerCount: Object.keys(this.roomState.players).length
      })
      
      // If room is empty, clean up
      if (Object.keys(this.roomState.players).length === 0) {
        await this.state.storage.deleteAll()
        this.roomState = null
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error('WebSocket error:', error)
  }

  // Broadcast using hibernation API - getWebSockets() returns all connected sockets
  private broadcast(message: object, excludePlayerId?: string) {
    const json = JSON.stringify(message)
    const sockets = this.state.getWebSockets()
    
    for (const ws of sockets) {
      const tags = this.state.getTags(ws)
      const socketPlayerId = tags[0]
      
      if (socketPlayerId !== excludePlayerId) {
        try {
          ws.send(json)
        } catch (e) {
          console.error('Failed to send to socket:', e)
        }
      }
    }
  }

  private sendTo(playerId: string, message: object) {
    const sockets = this.state.getWebSockets(playerId)
    const json = JSON.stringify(message)
    
    for (const ws of sockets) {
      try {
        ws.send(json)
      } catch (e) {
        console.error('Failed to send to socket:', e)
      }
    }
  }

  private async saveState() {
    if (this.roomState) {
      await this.state.storage.put('roomState', this.roomState)
    }
  }
}
