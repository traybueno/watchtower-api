/**
 * Room Durable Object — WebSocket Hibernation API
 *
 * Simple multiplayer room - routes messages, tracks players, assigns host.
 * No opinions on game logic. Server is a dumb pipe with metadata.
 *
 * Uses the WebSocket Hibernation API (this.state.acceptWebSocket) so idle rooms
 * don't incur wall-clock duration charges. Only billed for actual message processing.
 *
 * Features:
 * - WebSocket connections (hibernation-enabled)
 * - Broadcast to all players
 * - Direct messages between players
 * - Player tracking with metadata
 * - Auto host assignment
 * - Server timestamps + ticks for ordering
 * - Event history (ring buffer of last 50 events)
 * - Player kick (host only)
 * - CCU tracking integration
 * - 64KB message size limit
 */

interface Env {
  SAVES: KVNamespace
  CCU_COUNTERS?: DurableObjectNamespace
}

interface Player {
  id: string
  name?: string
  meta?: Record<string, unknown>
  joinedAt: number
}

interface WsAttachment {
  player: Player
  roomId: string
}

interface HistoryEvent {
  type: string
  serverTime: number
  tick: number
  [key: string]: unknown
}

const MAX_HISTORY_EVENTS = 50
const MAX_MESSAGE_SIZE = 65536 // 64KB

export class Room {
  private state: DurableObjectState
  private env: Env
  private hostId: string = ''
  private tick: number = 0
  private eventHistory: HistoryEvent[] = []
  private roomId: string = ''
  private initialized: boolean = false

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  /**
   * Rebuild in-memory state from hibernated WebSockets.
   * Called lazily on first access after the DO wakes from hibernation.
   */
  private ensureInitialized() {
    if (this.initialized) return
    this.initialized = true

    const websockets = this.state.getWebSockets()
    for (const ws of websockets) {
      const attachment = ws.deserializeAttachment() as WsAttachment | null
      if (attachment) {
        if (attachment.roomId) this.roomId = attachment.roomId
      }
    }

    // Restore tick from storage (best-effort)
    // tick and hostId are stored in blockConcurrencyWhile on connect
  }

  private getPlayers(): Map<string, Player> {
    const players = new Map<string, Player>()
    const websockets = this.state.getWebSockets()
    for (const ws of websockets) {
      const attachment = ws.deserializeAttachment() as WsAttachment | null
      if (attachment?.player) {
        players.set(attachment.player.id, attachment.player)
      }
    }
    return players
  }

  private getConnectionForWs(ws: WebSocket): WsAttachment | null {
    return ws.deserializeAttachment() as WsAttachment | null
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureInitialized()
    const url = new URL(request.url)

    if (url.pathname === '/ws') {
      return this.handleWebSocket(request, url)
    }

    if (url.pathname === '/info') {
      const players = this.getPlayers()
      return Response.json({
        playerCount: players.size,
        players: Array.from(players.values()),
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

    // Store roomId for CCU tracking on disconnect
    const roomIdParam = url.searchParams.get('roomId')
    if (roomIdParam && !this.roomId) {
      this.roomId = roomIdParam
    }

    const name = url.searchParams.get('name') || undefined
    const metaStr = url.searchParams.get('meta')
    const meta = metaStr ? JSON.parse(metaStr) : undefined

    // Handle reconnection - close old connection
    const existingWebSockets = this.state.getWebSockets()
    for (const existingWs of existingWebSockets) {
      const attachment = existingWs.deserializeAttachment() as WsAttachment | null
      if (attachment?.player.id === playerId) {
        try {
          existingWs.close(1000, 'Replaced by new connection')
        } catch {}
      }
    }

    // Create WebSocket pair
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Accept via Hibernation API — DO can now be evicted when idle
    const player: Player = {
      id: playerId,
      name,
      meta,
      joinedAt: Date.now()
    }

    this.state.acceptWebSocket(server)
    server.serializeAttachment({ player, roomId: this.roomId } satisfies WsAttachment)

    // Assign host if needed
    const players = this.getPlayers()
    if (!this.hostId || !players.has(this.hostId)) {
      this.hostId = playerId
    }

    // Send welcome message with recent events
    server.send(JSON.stringify({
      type: 'welcome',
      playerId,
      hostId: this.hostId,
      players: Array.from(players.values()),
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
      playerCount: players.size,
      tick: this.tick,
      serverTime: Date.now()
    }

    // Add to history
    this.addToHistory(joinEvent)

    // Notify others
    this.broadcast(joinEvent, server)

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Hibernation handler: called when a WebSocket receives a message.
   * The DO is automatically woken from hibernation to process this.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.ensureInitialized()

    const data = typeof message === 'string' ? message : new TextDecoder().decode(message)

    // Enforce message size limit (64KB)
    if (data.length > MAX_MESSAGE_SIZE) {
      ws.send(JSON.stringify({
        type: 'error',
        message: `Message too large (${data.length} bytes). Maximum is ${MAX_MESSAGE_SIZE} bytes.`,
        code: 'MESSAGE_TOO_LARGE'
      }))
      return
    }

    const attachment = this.getConnectionForWs(ws)
    if (!attachment) return

    try {
      const msg = JSON.parse(data)
      this.tick++

      switch (msg.type) {
        case 'broadcast': {
          const msgEvent: HistoryEvent = {
            type: 'message',
            from: attachment.player.id,
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
              from: attachment.player.id,
              data: msg.data,
              tick: this.tick,
              serverTime: Date.now()
            })
          }
          break

        case 'kick':
          // Only host can kick
          if (attachment.player.id !== this.hostId) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Only the host can kick players',
              tick: this.tick,
              serverTime: Date.now()
            }))
            break
          }

          this.handleKick(msg.playerId, msg.reason)
          break

        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            tick: this.tick,
            serverTime: Date.now(),
            playerCount: this.getPlayers().size
          }))
          break
      }
    } catch (e) {
      console.error('Error handling message:', e)
    }
  }

  /**
   * Hibernation handler: called when a WebSocket is closed.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.ensureInitialized()
    this.handleClose(ws)
  }

  /**
   * Hibernation handler: called when a WebSocket errors.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.ensureInitialized()
    this.handleClose(ws)
  }

  private handleKick(targetId: string, reason?: string) {
    const websockets = this.state.getWebSockets()
    for (const targetWs of websockets) {
      const targetAttachment = targetWs.deserializeAttachment() as WsAttachment | null
      if (targetAttachment?.player.id === targetId) {
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

        // Close connection
        try {
          targetWs.close(1000, reason || 'Kicked by host')
        } catch {}

        // Reassign host if kicked player was host
        const players = this.getPlayers()
        if (this.hostId === targetId) {
          const firstPlayer = players.keys().next().value
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
  }

  private handleClose(ws: WebSocket) {
    const attachment = this.getConnectionForWs(ws)
    if (!attachment) return

    const { player } = attachment

    // Decrement CCU counter (fire and forget)
    this.decrementCCU(player.id).catch(() => {})

    // Reassign host if needed
    const players = this.getPlayers()
    if (this.hostId === player.id) {
      // Find a player that isn't the one leaving
      let newHost = ''
      for (const [id] of players) {
        if (id !== player.id) {
          newHost = id
          break
        }
      }
      this.hostId = newHost

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
      playerCount: Math.max(0, players.size - 1),
      tick: this.tick,
      serverTime: Date.now()
    }

    // Add to history
    this.addToHistory(leaveEvent)

    // Notify others
    this.broadcast(leaveEvent, ws)
  }

  /**
   * Decrement CCU counter when player disconnects
   */
  private async decrementCCU(playerId: string): Promise<void> {
    if (!this.env.CCU_COUNTERS || !this.roomId) return

    try {
      // Look up user_id from KV (stored on connect)
      const userId = await this.env.SAVES.get(`ccu:${this.roomId}:${playerId}`)
      if (!userId) return

      // Get CCU counter for this user
      const ccuId = this.env.CCU_COUNTERS.idFromName(userId)
      const ccuStub = this.env.CCU_COUNTERS.get(ccuId)

      // Decrement
      await ccuStub.fetch(new Request('http://internal/disconnect', {
        method: 'POST',
        body: JSON.stringify({
          connectionId: `${this.roomId}:${playerId}`
        })
      }))

      // Clean up KV
      await this.env.SAVES.delete(`ccu:${this.roomId}:${playerId}`)
    } catch (e) {
      console.error('Failed to decrement CCU:', e)
    }
  }

  private broadcast(message: unknown, exclude?: WebSocket) {
    const data = JSON.stringify(message)
    const websockets = this.state.getWebSockets()
    for (const ws of websockets) {
      if (ws !== exclude) {
        try {
          ws.send(data)
        } catch {}
      }
    }
  }

  private sendTo(playerId: string, message: unknown) {
    const websockets = this.state.getWebSockets()
    for (const ws of websockets) {
      const attachment = ws.deserializeAttachment() as WsAttachment | null
      if (attachment?.player.id === playerId) {
        try {
          ws.send(JSON.stringify(message))
        } catch {}
        break
      }
    }
  }
}
