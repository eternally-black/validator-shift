/**
 * WebSocket room registry for the ValidatorShift hub.
 *
 * A `Room` represents a single migration session — at most two agents
 * (`source`, `target`) and any number of dashboard observers.
 *
 * CRITICAL INVARIANT (architecture section 3.1): the Hub NEVER decrypts or
 * decodes `agent:encrypted_payload`. This module only relays opaque blobs
 * between agents and notifies dashboards via metadata-only messages.
 */
import { WebSocket } from 'ws'
import type { AgentRole } from '@validator-shift/shared'
import type {
  HubToAgentMessage,
  HubToDashboardMessage,
} from '@validator-shift/shared/protocol'

/**
 * Serialize a hub-originated message and send over a single ws if it is open.
 * Returns true on a successful enqueue, false otherwise. Exported so handler.ts
 * can reuse it for snapshot fan-out without duplicating the readyState check.
 */
export function safeSend(
  ws: WebSocket | undefined,
  msg: HubToAgentMessage | HubToDashboardMessage,
): boolean {
  if (!ws) return false
  if (ws.readyState !== WebSocket.OPEN) return false
  try {
    ws.send(JSON.stringify(msg))
    return true
  } catch {
    return false
  }
}

export class Room {
  readonly sessionId: string
  readonly code: string
  readonly agents: { source?: WebSocket; target?: WebSocket } = {}
  readonly agentPubkeys: { source?: string; target?: string } = {}
  readonly dashboards: Set<WebSocket> = new Set()

  constructor(sessionId: string, code: string) {
    this.sessionId = sessionId
    this.code = code
  }

  /** Attach an agent socket for the given role. Caller is responsible for
   * checking peer-already-present before calling. */
  addAgent(role: AgentRole, ws: WebSocket): void {
    this.agents[role] = ws
  }

  /** Record the agent's X25519 public key from agent:hello. Used so the hub
   * can fan out hub:peer_connected once both agents have arrived. */
  setAgentPubkey(role: AgentRole, pubkey: string): void {
    this.agentPubkeys[role] = pubkey
  }

  hasBothPubkeys(): boolean {
    return (
      this.agentPubkeys.source !== undefined &&
      this.agentPubkeys.target !== undefined
    )
  }

  /** Detach an agent socket for the given role (if any). */
  removeAgent(role: AgentRole): void {
    delete this.agents[role]
    delete this.agentPubkeys[role]
  }

  addDashboard(ws: WebSocket): void {
    this.dashboards.add(ws)
  }

  removeDashboard(ws: WebSocket): void {
    this.dashboards.delete(ws)
  }

  hasBothAgents(): boolean {
    return this.agents.source !== undefined && this.agents.target !== undefined
  }

  /** Send a hub→agent message to the agent that is NOT `fromRole`. */
  relayToPeer(fromRole: AgentRole, msg: HubToAgentMessage): boolean {
    const peerRole: AgentRole = fromRole === 'source' ? 'target' : 'source'
    return safeSend(this.agents[peerRole], msg)
  }

  /** Send a hub→agent message directly to a specific role. */
  sendToAgent(role: AgentRole, msg: HubToAgentMessage): boolean {
    return safeSend(this.agents[role], msg)
  }

  /** Fan out a hub→dashboard message to every attached observer. */
  broadcastToDashboards(msg: HubToDashboardMessage): void {
    for (const ws of this.dashboards) {
      safeSend(ws, msg)
    }
  }

  /** Close every socket attached to this room with the given reason text. */
  closeAll(reason: string): void {
    const code = 1000
    const closeOne = (ws: WebSocket | undefined) => {
      if (!ws) return
      try {
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close(code, reason)
        }
      } catch {
        // best-effort cleanup
      }
    }
    closeOne(this.agents.source)
    closeOne(this.agents.target)
    for (const ws of this.dashboards) closeOne(ws)
    this.agents.source = undefined
    this.agents.target = undefined
    this.dashboards.clear()
  }
}

/**
 * In-memory registry keyed by sessionId, with a secondary index by session
 * code so agents (which connect with only the code) can find their room.
 */
export class RoomRegistry {
  private readonly byId: Map<string, Room> = new Map()
  private readonly byCode: Map<string, Room> = new Map()

  getOrCreate(sessionId: string, code: string): Room {
    const existing = this.byId.get(sessionId)
    if (existing) return existing
    const room = new Room(sessionId, code)
    this.byId.set(sessionId, room)
    this.byCode.set(code, room)
    return room
  }

  /** Lookup by either session id or session code. */
  get(sessionIdOrCode: string): Room | undefined {
    return this.byId.get(sessionIdOrCode) ?? this.byCode.get(sessionIdOrCode)
  }

  delete(sessionId: string): void {
    const room = this.byId.get(sessionId)
    if (!room) return
    this.byId.delete(sessionId)
    this.byCode.delete(room.code)
  }

  forEach(cb: (room: Room) => void): void {
    for (const room of this.byId.values()) cb(room)
  }
}
