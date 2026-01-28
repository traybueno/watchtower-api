interface Player {
  id: string
  joinedAt: number
}

interface RoomState {
  gameId: string
  hostId: string
  createdAt: number
  players: Record<string, Player>
  /** Per-player custom state (position, animation, etc.) */
  playerStates: Record<string, Record<string, unknown>>
  /** Shared game state (host-controlled) */
  gameState: Record<string, unknown>
}

export class GameRoom {
  private state: DurableObjectState
  private roomState: RoomState | null = null
  
  // Throttle player state broadcasts
  private playerStateDirty = false
  private broadcastInterval: ReturnType<typeof setInterval> | null = null
  private readonly SYNC_INTERVAL_MS = 50 // 20Hz

  constructor(state: DurableObjectState) {
    this.state = state
    
    // Restore state on wake
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<RoomState>('roomState')
      if (stored) {
        this.roomState = stored
        // Ensure new fields exist for backwards compatibility
        if (!this.roomState.playerStates) this.roomState.playerStates = {}
        if (!this.roomState.gameState) this.roomState.gameState = {}
      }
    })
    
    // Start periodic broadcast of player states
    this.startBroadcastInterval()
  }

  private startBroadcastInterval() {
    if (this.broadcastInterval) return
    
    this.broadcastInterval = setInterval(() => {
      if (this.playerStateDirty && this.roomState) {
        this.broadcast({
          type: 'players_sync',
          players: this.roomState.playerStates
        })
        this.playerStateDirty = false
      }
    }, this.SYNC_INTERVAL_MS)
  }

  private stopBroadcastInterval() {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval)
      this.broadcastInterval = null
    }
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
      players: { [hostId]: { id: hostId, joinedAt: Date.now() } },
      playerStates: {},
      gameState: {}
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

    // Send welcome message with full state
    server.send(JSON.stringify({
      type: 'connected',
      playerId,
      room: {
        code: '', // Filled by caller
        gameId: this.roomState.gameId,
        hostId: this.roomState.hostId,
        players: Object.values(this.roomState.players),
        playerCount: Object.keys(this.roomState.players).length
      },
      playerStates: this.roomState.playerStates,
      gameState: this.roomState.gameState
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
        case 'player_state':
          // Update this player's state
          this.roomState.playerStates[playerId] = data.state
          this.playerStateDirty = true
          // Also send individual update for lower latency
          this.broadcast({
            type: 'player_state_update',
            playerId,
            state: data.state
          }, playerId)
          break
          
        case 'game_state':
          // Only host can set game state
          if (playerId === this.roomState.hostId) {
            this.roomState.gameState = data.state
            await this.saveState()
            // Broadcast to all including sender (confirmation)
            this.broadcast({
              type: 'game_state_sync',
              state: data.state
            })
          }
          break
          
        case 'transfer_host':
          // Only host can transfer
          if (playerId === this.roomState.hostId && data.newHostId) {
            // Verify new host is in room
            if (this.roomState.players[data.newHostId]) {
              this.roomState.hostId = data.newHostId
              await this.saveState()
              this.broadcast({
                type: 'host_changed',
                hostId: data.newHostId
              })
            }
          }
          break
          
        case 'broadcast':
          // Broadcast to all players (for one-off events)
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
      const wasHost = playerId === this.roomState.hostId
      
      // Remove player
      delete this.roomState.players[playerId]
      delete this.roomState.playerStates[playerId]
      
      const remainingPlayers = Object.keys(this.roomState.players)
      
      // If room is empty, clean up
      if (remainingPlayers.length === 0) {
        this.stopBroadcastInterval()
        await this.state.storage.deleteAll()
        this.roomState = null
        return
      }
      
      // Host migration if host left
      if (wasHost && remainingPlayers.length > 0) {
        // Pick the player who joined earliest as new host
        const players = Object.values(this.roomState.players)
        players.sort((a, b) => a.joinedAt - b.joinedAt)
        this.roomState.hostId = players[0].id
        
        // Notify all players of host change
        this.broadcast({
          type: 'host_changed',
          hostId: this.roomState.hostId
        })
      }
      
      await this.saveState()
      
      // Broadcast player left
      this.broadcast({
        type: 'player_left',
        playerId,
        playerCount: remainingPlayers.length
      })
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
