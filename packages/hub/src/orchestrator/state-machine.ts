import { EventEmitter } from 'node:events'
import {
  MigrationState,
  type AgentRole,
  type PreflightCheck,
  type StepResult,
  type MigrationSummary,
} from '@validator-shift/shared'
import { BILATERAL_STEPS, getExecutor, nextStep, TOTAL_STEPS } from './steps.js'
import { getRollbackSteps, shouldRollback, type RollbackStep } from './rollback.js'

/**
 * Thrown when callers attempt a state transition that is not part of
 * the documented state machine (architecture section 4). Surfacing this
 * as a distinct error class makes it easy to log + reject misbehaving
 * peers without conflating it with internal bugs.
 */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: MigrationState,
    public readonly to: MigrationState,
    reason?: string,
  ) {
    super(
      `Invalid transition from ${from} to ${to}${reason ? `: ${reason}` : ''}`,
    )
    this.name = 'InvalidTransitionError'
  }
}

/**
 * Map of valid transitions per the architecture state diagram.
 *
 * Note: FAILED via abort() and the disconnect-driven transitions are
 * handled separately in the methods below — they're not "natural"
 * progression edges, they're operator/network overrides.
 */
const ALLOWED_TRANSITIONS: Record<MigrationState, ReadonlySet<MigrationState>> = {
  [MigrationState.IDLE]: new Set([MigrationState.PAIRING, MigrationState.FAILED]),
  [MigrationState.PAIRING]: new Set([
    MigrationState.PREFLIGHT,
    MigrationState.IDLE, // disconnect during PAIRING
    MigrationState.FAILED, // abort
  ]),
  [MigrationState.PREFLIGHT]: new Set([
    MigrationState.AWAITING_WINDOW,
    MigrationState.FAILED,
    MigrationState.IDLE, // disconnect during PREFLIGHT → reset to IDLE
  ]),
  [MigrationState.AWAITING_WINDOW]: new Set([
    MigrationState.MIGRATING,
    MigrationState.FAILED, // abort
  ]),
  [MigrationState.MIGRATING]: new Set([
    MigrationState.COMPLETE,
    MigrationState.ROLLBACK,
    MigrationState.FAILED, // abort with no rollback (e.g. step 1 failure)
  ]),
  [MigrationState.ROLLBACK]: new Set([MigrationState.FAILED]),
  // Terminal states — no further transitions allowed.
  [MigrationState.COMPLETE]: new Set(),
  [MigrationState.FAILED]: new Set(),
}

/** Connection bookkeeping for the two agents. */
interface AgentConnections {
  source: boolean
  target: boolean
}

/** SAS confirmation bookkeeping. */
interface SasConfirmations {
  source: boolean
  target: boolean
}

/** Per-role preflight results. We need both agents' results to advance. */
interface PreflightResults {
  source: PreflightCheck[] | null
  target: PreflightCheck[] | null
}

/**
 * Strongly-typed event map for MigrationOrchestrator.
 *
 * We use `node:events` EventEmitter under the hood, but expose typed
 * `on` / `emit` overloads so consumers (and tests) get full type safety
 * on event names + payloads.
 */
export type OrchestratorEvents = {
  state_change: { from: MigrationState; to: MigrationState }
  execute_step: { role: AgentRole; step: number }
  rollback: { rollbackStep: RollbackStep }
  session_complete: MigrationSummary
  session_failed: { reason: string }
  critical_alert: { reason: string }
}

type EventName = keyof OrchestratorEvents

export interface MigrationOrchestrator {
  on<E extends EventName>(event: E, listener: (payload: OrchestratorEvents[E]) => void): this
  once<E extends EventName>(event: E, listener: (payload: OrchestratorEvents[E]) => void): this
  off<E extends EventName>(event: E, listener: (payload: OrchestratorEvents[E]) => void): this
  emit<E extends EventName>(event: E, payload: OrchestratorEvents[E]): boolean
}

/**
 * Orchestrates a single migration session through its state machine.
 *
 * Responsibilities:
 *   - Track current state + session metadata.
 *   - Validate transitions (throw InvalidTransitionError on violations).
 *   - Translate agent / dashboard events into state changes.
 *   - Emit `execute_step` instructions for the appropriate agent.
 *   - Handle disconnect / abort edge cases (architecture section 10.2).
 *
 * NON-responsibilities:
 *   - Running Solana CLI commands (agents do that).
 *   - Network I/O (the WS layer wraps emitted events).
 *   - Persistence (the DB layer subscribes to events).
 */
export class MigrationOrchestrator extends EventEmitter {
  private _state: MigrationState = MigrationState.IDLE
  private readonly _sessionId: string
  private readonly _startedAt: number
  private _agents: AgentConnections = { source: false, target: false }
  private _sas: SasConfirmations = { source: false, target: false }
  private _preflight: PreflightResults = { source: null, target: null }
  private _currentStep = 0
  private _stepsCompleted = 0
  private _started = false
  private _migrationStartedAt: number | null = null
  /**
   * Per-step set of roles that have acked `agent:step_complete`. Only
   * meaningful for steps in BILATERAL_STEPS — for unilateral steps the
   * single executor's ack advances immediately. Cleared once a bilateral
   * step's gate passes; entries for non-current steps are pruned by the
   * `step !== currentStep` guard at call time.
   */
  private readonly _bilateralAcks: Map<number, Set<AgentRole>> = new Map()

  constructor(sessionId: string) {
    super()
    this._sessionId = sessionId
    this._startedAt = Date.now()
  }

  // ---------------------------------------------------------------
  // Public read-only accessors
  // ---------------------------------------------------------------

  get state(): MigrationState {
    return this._state
  }

  get sessionId(): string {
    return this._sessionId
  }

  get currentStep(): number {
    return this._currentStep
  }

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  /**
   * Marks the orchestrator as "live". Calling this twice is a bug —
   * each session gets its own orchestrator instance, so a double-start
   * almost certainly means something is replaying messages.
   */
  start(): void {
    if (this._started) {
      throw new Error(`Orchestrator already started for session ${this._sessionId}`)
    }
    this._started = true
  }

  /**
   * Operator-initiated abort. Behavior depends on current state:
   *   - From any active state with mutated source identity (MIGRATING
   *     past step 2): go to ROLLBACK so we can restore source.
   *   - Otherwise: go straight to FAILED.
   *
   * Calling abort from a terminal state is a no-op (idempotent), since
   * sessions can legitimately receive late abort signals.
   */
  abort(reason: string): void {
    if (this.isTerminal()) return

    if (
      this._state === MigrationState.MIGRATING &&
      shouldRollback(this._currentStep)
    ) {
      this.beginRollback(reason)
    } else {
      this.transition(MigrationState.FAILED, `aborted: ${reason}`)
      this.emit('session_failed', { reason: `aborted: ${reason}` })
    }
  }

  // ---------------------------------------------------------------
  // Agent connectivity
  // ---------------------------------------------------------------

  /**
   * Called when an agent's WebSocket connects. Once both agents are
   * connected, IDLE → PAIRING. This is the only path into PAIRING.
   */
  onAgentConnected(role: AgentRole): void {
    this._agents[role] = true
    if (
      this._state === MigrationState.IDLE &&
      this._agents.source &&
      this._agents.target
    ) {
      this.transition(MigrationState.PAIRING, 'both agents connected')
    }
  }

  /**
   * Disconnect handling, per architecture section 10.2:
   *   - PAIRING / PREFLIGHT → drop back to IDLE (operator can retry).
   *   - MIGRATING (source) before step 5 → ROLLBACK (we still own the keypair).
   *   - MIGRATING (target) after step 5 → CRITICAL ALERT, stay in MIGRATING.
   *     The target may have the keypair already; only the operator can
   *     safely resolve dual-identity risk.
   *   - All other cases: just record disconnect, no transition.
   */
  onAgentDisconnected(role: AgentRole): void {
    this._agents[role] = false

    if (
      this._state === MigrationState.PAIRING ||
      this._state === MigrationState.PREFLIGHT
    ) {
      // Reset SAS / preflight state so we re-pair cleanly.
      this._sas = { source: false, target: false }
      this._preflight = { source: null, target: null }
      this.transition(MigrationState.IDLE, `${role} disconnected during pairing`)
      return
    }

    if (this._state === MigrationState.MIGRATING) {
      if (role === 'source' && this._currentStep < 5) {
        // Source went away before the keypair transfer completed —
        // safe to roll back; we still control the staked identity.
        this.beginRollback(`source disconnected at step ${this._currentStep}`)
        return
      }
      if (role === 'target' && this._currentStep >= 5) {
        // Target may already hold the keypair. Automated rollback is
        // unsafe (could leave the keypair on target while restoring
        // source → dual-signing). Escalate to operator.
        this.emit('critical_alert', {
          reason: `target disconnected after step ${this._currentStep}; manual intervention required`,
        })
        return
      }
    }
  }

  // ---------------------------------------------------------------
  // SAS verification → PREFLIGHT
  // ---------------------------------------------------------------

  /**
   * SAS confirmation from one agent. We only advance to PREFLIGHT once
   * BOTH agents have confirmed — confirming SAS on one side alone is
   * meaningless (the operator must visually compare both terminals).
   */
  onSasConfirmed(role: AgentRole): void {
    if (this._state !== MigrationState.PAIRING) return
    this._sas[role] = true
    if (this._sas.source && this._sas.target) {
      this.transition(MigrationState.PREFLIGHT, 'both SAS confirmed')
    }
  }

  // ---------------------------------------------------------------
  // Preflight → AWAITING_WINDOW or FAILED
  // ---------------------------------------------------------------

  /**
   * Preflight results from one agent. We collect both, then evaluate:
   *   - Any failed check → FAILED (with session_failed reason).
   *   - All ok → AWAITING_WINDOW (waiting for dashboard start).
   */
  onPreflightResult(role: AgentRole, checks: PreflightCheck[]): void {
    if (this._state !== MigrationState.PREFLIGHT) return
    this._preflight[role] = checks

    const { source, target } = this._preflight
    if (!source || !target) return // wait for the other agent

    const failed = [...source, ...target].filter((c) => !c.ok)
    if (failed.length > 0) {
      const reason =
        'preflight failed: ' +
        failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join(', ')
      this.transition(MigrationState.FAILED, reason)
      this.emit('session_failed', { reason })
      return
    }

    this.transition(MigrationState.AWAITING_WINDOW, 'all preflight checks passed')
  }

  // ---------------------------------------------------------------
  // Dashboard-driven start of MIGRATING
  // ---------------------------------------------------------------

  /**
   * Operator clicked "Start Migration" on the dashboard. We move from
   * AWAITING_WINDOW → MIGRATING and dispatch step 1. Calling this from
   * any other state is invalid.
   */
  startMigration(): void {
    if (this._state !== MigrationState.AWAITING_WINDOW) {
      throw new InvalidTransitionError(
        this._state,
        MigrationState.MIGRATING,
        'startMigration only valid from AWAITING_WINDOW',
      )
    }
    this.transition(MigrationState.MIGRATING, 'dashboard start_migration')
    this._migrationStartedAt = Date.now()
    this._currentStep = 1
    this.emit('execute_step', { role: getExecutor(1), step: 1 })
  }

  // ---------------------------------------------------------------
  // Per-step results
  // ---------------------------------------------------------------

  /**
   * Agent reports a step succeeded. Advance to the next step, or — if
   * we just finished the final step — emit session_complete and move
   * to COMPLETE. Steps reported out of order are ignored (defensive).
   *
   * Bilateral steps (BILATERAL_STEPS) require BOTH source and target to
   * ack before advancing. Without this gate, source rapidly reports
   * step 5 complete after sending the encrypted identity payload and
   * the orchestrator dispatches step 6 to target before target's step 5
   * handler has consumed the payload from the relay queue — resulting
   * in `staked keypair not received before step 6`.
   */
  onStepComplete(step: number, role: AgentRole, _result: StepResult): void {
    if (this._state !== MigrationState.MIGRATING) return
    if (step !== this._currentStep) return // stale / duplicate

    if (BILATERAL_STEPS.has(step)) {
      let acks = this._bilateralAcks.get(step)
      if (!acks) {
        acks = new Set()
        this._bilateralAcks.set(step, acks)
      }
      acks.add(role)
      if (!(acks.has('source') && acks.has('target'))) return
      this._bilateralAcks.delete(step)
    }

    this._stepsCompleted += 1
    const next = nextStep(step)
    if (!next) {
      // All TOTAL_STEPS done.
      this.finishSession()
      return
    }
    this._currentStep = next.number
    this.emit('execute_step', { role: next.executor, step: next.number })
  }

  /**
   * Agent reports a step failed. Per architecture section 4.3:
   *   - Failure on step 1 (wait_for_restart_window) → no validator
   *     state changed yet → straight to FAILED, no rollback.
   *   - Failure on step ≥ 2 → ROLLBACK.
   *
   * On bilateral steps, a failure from EITHER side trips rollback
   * immediately — we don't wait for the other agent's ack first.
   */
  onStepFailed(step: number, role: AgentRole, error: string): void {
    if (this._state !== MigrationState.MIGRATING) return
    if (step !== this._currentStep) return

    if (shouldRollback(step)) {
      this.beginRollback(`step ${step} failed on ${role}: ${error}`)
    } else {
      const reason = `step ${step} failed on ${role}: ${error}`
      this.transition(MigrationState.FAILED, reason)
      this.emit('session_failed', { reason })
    }
  }

  // ---------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------

  private beginRollback(reason: string): void {
    this.transition(MigrationState.ROLLBACK, reason)
    const steps = getRollbackSteps(this._currentStep)
    for (const rollbackStep of steps) {
      this.emit('rollback', { rollbackStep })
    }
    // Rollback steps are dispatched optimistically; once they're all
    // emitted we mark the session FAILED. The agents handle the actual
    // execution; failures inside rollback are surfaced via logs.
    this.transition(MigrationState.FAILED, `rollback complete: ${reason}`)
    this.emit('session_failed', { reason })
  }

  private finishSession(): void {
    const finishedAt = Date.now()
    const startedAt = this._migrationStartedAt ?? this._startedAt
    this.transition(MigrationState.COMPLETE, 'all steps succeeded')
    const summary: MigrationSummary = {
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      stepsCompleted: this._stepsCompleted,
      finalState: MigrationState.COMPLETE,
    }
    this.emit('session_complete', summary)
  }

  /**
   * Centralized transition helper. Validates the edge against
   * ALLOWED_TRANSITIONS, updates state, and emits state_change.
   *
   * Self-loops (from === to) are no-ops — convenient for idempotent
   * call sites that don't want to track current state themselves.
   */
  private transition(to: MigrationState, reason?: string): void {
    const from = this._state
    if (from === to) return
    const allowed = ALLOWED_TRANSITIONS[from]
    if (!allowed.has(to)) {
      throw new InvalidTransitionError(from, to, reason)
    }
    this._state = to
    this.emit('state_change', { from, to })
  }

  private isTerminal(): boolean {
    return (
      this._state === MigrationState.COMPLETE ||
      this._state === MigrationState.FAILED
    )
  }
}

/** Re-exported so consumers can pin to TOTAL_STEPS without an extra import. */
export { TOTAL_STEPS }
