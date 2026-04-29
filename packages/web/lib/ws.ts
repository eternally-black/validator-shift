import {
  DashboardMessageSchema,
  HubToDashboardMessageSchema,
  parseMessage,
  type DashboardMessage,
  type HubToDashboardMessage,
} from '@validator-shift/shared/protocol'

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error'

export interface DashboardClientOpts {
  sessionId: string
  /**
   * Single hub origin (http:// or https://). Internally converted to
   * ws:// or wss:// for the WebSocket upgrade — hub serves both schemes
   * on the same port.
   */
  hubUrl: string
  /**
   * Bearer token returned by POST /api/sessions. Required by the hub —
   * connections without a valid token are closed with code 4401.
   */
  token: string
}

/** Convert an http(s) origin into the matching ws(s) origin. */
function toWsOrigin(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):/i, 'ws$1:')
}

/**
 * Cap reconnect attempts to prevent a tab on a dead session from holding
 * a hub connection slot indefinitely. ~30 attempts in <8 minutes given
 * the exponential backoff capped at 15s.
 */
const MAX_RECONNECT_ATTEMPTS = 30

type MessageHandler = (msg: HubToDashboardMessage) => void
type StatusHandler = (status: ConnectionStatus) => void

const isDev =
  typeof process !== 'undefined' &&
  process.env &&
  process.env.NODE_ENV === 'development'

/**
 * Browser-side WebSocket client for the ValidatorShift dashboard channel.
 *
 * Connects to `${hubWsUrl}/ws/dashboard/${sessionId}`, validates incoming and
 * outgoing messages with the shared zod schemas, and auto-reconnects with
 * exponential backoff (1s, 2s, 4s, ... capped at 15s, no attempt limit).
 */
export class DashboardClient {
  private readonly sessionId: string
  private readonly hubWsOrigin: string
  private readonly token: string

  private ws: WebSocket | null = null
  private messageHandlers = new Set<MessageHandler>()
  private statusHandlers = new Set<StatusHandler>()

  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionallyClosed = false
  private currentStatus: ConnectionStatus = 'closed'

  constructor(opts: DashboardClientOpts) {
    this.sessionId = opts.sessionId
    this.hubWsOrigin = toWsOrigin(opts.hubUrl).replace(/\/+$/, '')
    this.token = opts.token
  }

  connect(): void {
    this.intentionallyClosed = false
    this.openSocket()
  }

  disconnect(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.setStatus('closed')
  }

  send(msg: DashboardMessage): void {
    // Validate before send — throws on invalid (developer error).
    const validated = DashboardMessageSchema.parse(msg)
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (isDev) {
        console.warn(
          '[DashboardClient] send() called while socket is not OPEN; dropping message',
          validated,
        )
      }
      return
    }
    this.ws.send(JSON.stringify(validated))
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => {
      this.messageHandlers.delete(handler)
    }
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    // Emit current status synchronously so subscribers can sync immediately.
    handler(this.currentStatus)
    return () => {
      this.statusHandlers.delete(handler)
    }
  }

  // ---------- internals ----------

  private openSocket(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const url = `${this.hubWsOrigin}/ws/dashboard/${encodeURIComponent(this.sessionId)}?token=${encodeURIComponent(this.token)}`
    this.setStatus('connecting')

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (err) {
      if (isDev) {
        console.warn('[DashboardClient] failed to construct WebSocket', err)
      }
      this.setStatus('error')
      this.scheduleReconnect()
      return
    }
    this.ws = socket

    socket.onopen = () => {
      this.reconnectAttempts = 0
      this.setStatus('open')
    }

    socket.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : ''
      if (!raw) return

      const parsed = parseMessage(raw)
      if (!parsed.ok) {
        if (isDev) {
          console.warn('[DashboardClient] failed to parse message:', parsed.error)
        }
        return
      }

      const dashResult = HubToDashboardMessageSchema.safeParse(parsed.data)
      if (!dashResult.success) {
        if (isDev) {
          console.warn(
            '[DashboardClient] message is not a HubToDashboardMessage:',
            dashResult.error.message,
          )
        }
        return
      }

      const msg = dashResult.data
      for (const handler of this.messageHandlers) {
        try {
          handler(msg)
        } catch (err) {
          if (isDev) {
            console.warn('[DashboardClient] message handler threw', err)
          }
        }
      }
    }

    socket.onerror = () => {
      this.setStatus('error')
    }

    socket.onclose = () => {
      this.ws = null
      if (this.intentionallyClosed) {
        this.setStatus('closed')
        return
      }
      this.setStatus('closed')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (isDev) {
        console.warn(
          `[DashboardClient] reconnect attempts exceeded (${MAX_RECONNECT_ATTEMPTS}); giving up`,
        )
      }
      this.setStatus('error')
      this.intentionallyClosed = true
      return
    }
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.currentStatus === status) {
      // still emit on transitions like connecting->connecting? Skip to avoid noise.
      return
    }
    this.currentStatus = status
    for (const handler of this.statusHandlers) {
      try {
        handler(status)
      } catch (err) {
        if (isDev) {
          console.warn('[DashboardClient] status handler threw', err)
        }
      }
    }
  }
}

// Re-export of wireClientToStore so callers may import it from either '@/lib/ws' or '@/lib/store'.
export { wireClientToStore } from './store'
