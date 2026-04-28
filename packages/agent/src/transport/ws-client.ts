import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import {
  AgentMessageSchema,
  HubToAgentMessageSchema,
  parseMessage,
  type AgentMessage,
} from '@validator-shift/shared/protocol'
import {
  HEARTBEAT_INTERVAL_MS,
  PAIRING_RECONNECT_MAX_ATTEMPTS,
} from '@validator-shift/shared/constants'

export type AgentRole = 'source' | 'target'
export type ConnectionStage = 'pairing' | 'preflight' | 'migrating' | 'safe'

export interface HubClientOptions {
  hubUrl: string
  sessionCode: string
  role: AgentRole
  publicKey: string
}

const RECONNECTABLE_STAGES: ReadonlySet<ConnectionStage> = new Set([
  'pairing',
  'preflight',
])

export class HubClient extends EventEmitter {
  private readonly hubUrl: string
  private readonly sessionCode: string
  private readonly role: AgentRole
  private readonly publicKey: string

  private ws: WebSocket | null = null
  private stage: ConnectionStage = 'pairing'

  private heartbeatTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null

  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null

  private manualClose = false
  private connecting = false

  constructor(opts: HubClientOptions) {
    super()
    this.hubUrl = opts.hubUrl.replace(/\/+$/, '')
    this.sessionCode = opts.sessionCode
    this.role = opts.role
    this.publicKey = opts.publicKey
  }

  connect(): Promise<void> {
    this.manualClose = false
    return this.openSocket()
  }

  send(msg: AgentMessage): void {
    // Validates and throws on invalid input.
    const validated = AgentMessageSchema.parse(msg)
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('HubClient: cannot send, socket is not open')
    }
    this.ws.send(JSON.stringify(validated))
  }

  setStage(stage: ConnectionStage): void {
    this.stage = stage
  }

  close(reason?: string): void {
    this.manualClose = true
    this.clearReconnectTimer()
    this.stopHeartbeat()
    if (this.ws) {
      try {
        this.ws.close(1000, reason ?? 'client_close')
      } catch {
        // ignore
      }
      this.ws = null
    }
  }

  // --- internal -------------------------------------------------------------

  private openSocket(): Promise<void> {
    if (this.connecting) {
      return Promise.resolve()
    }
    this.connecting = true

    const url = `${this.hubUrl}/ws/session/${this.sessionCode}`

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(url)
      this.ws = ws

      ws.on('open', () => {
        this.connecting = false
        this.reconnectAttempts = 0
        this.emit('open')

        try {
          this.send({
            type: 'agent:hello',
            role: this.role,
            sessionCode: this.sessionCode,
            publicKey: this.publicKey,
          })
        } catch (err) {
          this.emit('error', err)
        }

        this.startHeartbeat()

        if (!settled) {
          settled = true
          resolve()
        }
      })

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const text =
          typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString('utf8')
              : Buffer.from(raw as ArrayBuffer).toString('utf8')

        const result = parseMessage(text)
        if (!result.ok) {
          this.emit('protocol_error', new Error(result.error))
          return
        }

        const dataParse = HubToAgentMessageSchema.safeParse(result.data)
        if (!dataParse.success) {
          this.emit('protocol_error', new Error(dataParse.error.message))
          return
        }

        const data = dataParse.data
        this.emit(data.type, data)
        this.emit('message', data)
      })

      ws.on('pong', () => {
        this.armPongTimer()
      })

      ws.on('error', (err) => {
        this.emit('error', err)
        if (!settled) {
          settled = true
          this.connecting = false
          reject(err)
        }
      })

      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf?.toString?.() ?? ''
        this.connecting = false
        this.stopHeartbeat()
        this.ws = null
        this.emit('close', { code, reason })

        if (this.manualClose) {
          return
        }

        if (this.stage === 'migrating') {
          // Critical: never silently reconnect mid-migration.
          this.setStage('safe')
          this.emit('disconnected_unsafe', { code, reason })
          return
        }

        if (RECONNECTABLE_STAGES.has(this.stage)) {
          this.scheduleReconnect()
        }
      })
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.armPongTimer()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping()
        } catch (err) {
          this.emit('error', err)
        }
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private armPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
    }
    this.pongTimer = setTimeout(() => {
      // No pong within 2× heartbeat → assume dead.
      this.emit('timeout')
      this.close('timeout')
    }, HEARTBEAT_INTERVAL_MS * 2)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= PAIRING_RECONNECT_MAX_ATTEMPTS) {
      return
    }
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000)
    this.reconnectAttempts += 1
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      // Re-check stage at fire time — operator may have advanced state.
      if (!RECONNECTABLE_STAGES.has(this.stage) || this.manualClose) {
        return
      }
      this.openSocket().catch((err) => {
        this.emit('error', err)
        if (RECONNECTABLE_STAGES.has(this.stage) && !this.manualClose) {
          this.scheduleReconnect()
        }
      })
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
