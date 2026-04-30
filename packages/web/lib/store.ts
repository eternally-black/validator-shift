import { create, type StoreApi, type UseBoundStore } from 'zustand'
import {
  MigrationState,
  type AgentStatus,
  type LogEntry,
  type MigrationSummary,
  type PreflightCheck,
  type Session,
  type StepProgress,
} from '@validator-shift/shared'
import {
  DashboardMessageSchema,
  type DashboardMessage,
  type HubToDashboardMessage,
} from '@validator-shift/shared/protocol'
import type { ConnectionStatus, DashboardClient } from './ws'

const isDev =
  typeof process !== 'undefined' &&
  process.env &&
  process.env.NODE_ENV === 'development'

const LOG_BUFFER_LIMIT = 1000

/**
 * Operator-supplied paths from Step 1. Carried into Step 2 so the
 * wizard can render fully-substituted agent invocations (no
 * placeholders for the operator to fill). Never sent over the wire —
 * lives in browser memory only and is wiped on `reset()`.
 */
export interface AgentConfig {
  ledgerPath: string
  keypairPath: string
}

export interface SessionStoreState {
  session: Session | null
  state: MigrationState
  agents: { source: AgentStatus; target: AgentStatus }
  preflight: PreflightCheck[]
  steps: StepProgress[]
  logs: LogEntry[]
  sas: string | null
  lastError: string | null
  connection: ConnectionStatus
  summary: MigrationSummary | null
  /**
   * Bearer token returned by POST /api/sessions. Required to open the
   * dashboard WebSocket — without it the hub closes the connection 4401.
   * Lives only in client memory; never persisted (plain object, not in
   * sessionStorage).
   */
  dashboardToken: string | null
  config: AgentConfig | null

  // Internal — kept in state so subscribers don't accidentally serialize it,
  // but exposed via attach/detach actions only.
  _client: DashboardClient | null

  // ---- actions ----
  setSession: (session: Session | null) => void
  setDashboardToken: (token: string | null) => void
  setConfig: (config: AgentConfig | null) => void
  setState: (state: MigrationState) => void
  setAgents: (agents: Partial<{ source: AgentStatus; target: AgentStatus }>) => void
  setPreflight: (checks: PreflightCheck[]) => void
  updateStep: (step: StepProgress) => void
  appendLog: (entry: LogEntry) => void
  setSas: (sas: string | null) => void
  setError: (error: string | null) => void
  setConnection: (status: ConnectionStatus) => void
  setSummary: (summary: MigrationSummary | null) => void
  reset: () => void

  attachClient: (client: DashboardClient) => void
  detachClient: () => void
  dispatch: (msg: DashboardMessage) => void
}

const defaultAgents = (): { source: AgentStatus; target: AgentStatus } => ({
  source: { role: 'source', connected: false },
  target: { role: 'target', connected: false },
})

const initialState = (): Omit<
  SessionStoreState,
  | 'setSession'
  | 'setDashboardToken'
  | 'setConfig'
  | 'setState'
  | 'setAgents'
  | 'setPreflight'
  | 'updateStep'
  | 'appendLog'
  | 'setSas'
  | 'setError'
  | 'setConnection'
  | 'setSummary'
  | 'reset'
  | 'attachClient'
  | 'detachClient'
  | 'dispatch'
> => ({
  session: null,
  state: MigrationState.IDLE,
  agents: defaultAgents(),
  preflight: [],
  steps: [],
  logs: [],
  sas: null,
  lastError: null,
  connection: 'closed',
  summary: null,
  dashboardToken: null,
  config: null,
  _client: null,
})

export const useSessionStore: UseBoundStore<StoreApi<SessionStoreState>> =
  create<SessionStoreState>((set, get) => ({
    ...initialState(),

    setSession: (session) => set({ session }),

    setDashboardToken: (token) => set({ dashboardToken: token }),

    setConfig: (config) => set({ config }),

    setState: (state) => set({ state }),

    setAgents: (agents) =>
      set((s) => ({
        agents: {
          source: agents.source ?? s.agents.source,
          target: agents.target ?? s.agents.target,
        },
      })),

    setPreflight: (checks) => set({ preflight: checks }),

    updateStep: (step) =>
      set((s) => {
        const idx = s.steps.findIndex((x) => x.step === step.step)
        if (idx === -1) {
          return { steps: [...s.steps, step] }
        }
        const next = s.steps.slice()
        next[idx] = step
        return { steps: next }
      }),

    appendLog: (entry) =>
      set((s) => {
        const next = s.logs.length >= LOG_BUFFER_LIMIT
          ? s.logs.slice(-LOG_BUFFER_LIMIT + 1)
          : s.logs.slice()
        next.push(entry)
        return { logs: next }
      }),

    setSas: (sas) => set({ sas }),

    setError: (error) => set({ lastError: error }),

    setConnection: (status) => set({ connection: status }),

    setSummary: (summary) => set({ summary }),

    reset: () =>
      set((s) => ({
        ...initialState(),
        // preserve attached client across reset — caller decides via detach.
        _client: s._client,
      })),

    attachClient: (client) => set({ _client: client }),

    detachClient: () => set({ _client: null }),

    dispatch: (msg) => {
      const validated = DashboardMessageSchema.safeParse(msg)
      if (!validated.success) {
        if (isDev) {
          console.warn(
            '[useSessionStore.dispatch] invalid DashboardMessage:',
            validated.error.message,
          )
        }
        return
      }
      const client = get()._client
      if (!client) {
        if (isDev) {
          console.warn(
            '[useSessionStore.dispatch] no client attached; dropping message',
            validated.data,
          )
        }
        return
      }
      client.send(validated.data)
    },
  }))

/**
 * Wires a DashboardClient to the session store: routes incoming
 * HubToDashboardMessages to the matching store actions and forwards
 * connection status changes. Returns an unsubscribe function that
 * detaches both subscriptions.
 */
export function wireClientToStore(
  client: DashboardClient,
  store: typeof useSessionStore,
): () => void {
  const s = store.getState()
  s.attachClient(client)

  const offMsg = client.onMessage((msg: HubToDashboardMessage) => {
    const st = store.getState()
    switch (msg.type) {
      case 'dashboard:state_change':
        st.setState(msg.state as MigrationState)
        break
      case 'dashboard:agents_status':
        st.setAgents({ source: msg.source, target: msg.target })
        break
      case 'dashboard:preflight_update':
        st.setPreflight(msg.checks)
        break
      case 'dashboard:step_progress':
        st.updateStep({ step: msg.step, status: msg.status })
        break
      case 'dashboard:log': {
        const level: LogEntry['level'] =
          msg.level === 'warn' || msg.level === 'error' ? msg.level : 'info'
        st.appendLog({
          ts: msg.ts,
          agent: msg.agent,
          level,
          message: msg.message,
        })
        break
      }
      case 'dashboard:migration_complete':
        st.setSummary(msg.summary)
        st.setState(MigrationState.COMPLETE)
        break
      default: {
        // Exhaustiveness check.
        const _exhaustive: never = msg
        void _exhaustive
      }
    }
  })

  const offStatus = client.onStatus((status: ConnectionStatus) => {
    store.getState().setConnection(status)
  })

  return () => {
    offMsg()
    offStatus()
    store.getState().detachClient()
  }
}
