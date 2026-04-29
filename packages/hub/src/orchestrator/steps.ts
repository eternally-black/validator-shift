import { MIGRATION_STEPS } from '@validator-shift/shared/constants'
import type { AgentRole, StepResult } from '@validator-shift/shared'

/**
 * Definition of a single migration step.
 *
 * `executor` indicates which agent (source or target) is responsible for
 * actually running the underlying command. The orchestrator never runs
 * any Solana CLI itself — it only emits an `execute_step` instruction
 * targeted at the appropriate agent.
 */
export interface MigrationStep {
  number: number
  name: string
  executor: AgentRole
  /** Per-step timeout in milliseconds. */
  timeoutMs: number
  /**
   * True only for step 1 (`wait_for_restart_window`), which depends on
   * leader-schedule timing rather than a deterministic action.
   */
  requiresWindow?: boolean
}

/** Default timeout for "fast" steps (set-identity, voter ops, verify, cleanup). */
const DEFAULT_TIMEOUT_MS = 30_000
/** File-transfer steps (tower file, identity keypair) — slower I/O + relay. */
const TRANSFER_TIMEOUT_MS = 120_000
/** Restart window can take a long time depending on leader schedule. */
const RESTART_WINDOW_TIMEOUT_MS = 1_800_000 // 30 min

function timeoutForStep(stepNumber: number): number {
  if (stepNumber === 1) return RESTART_WINDOW_TIMEOUT_MS
  if (stepNumber === 4 || stepNumber === 5) return TRANSFER_TIMEOUT_MS
  return DEFAULT_TIMEOUT_MS
}

/**
 * Internal table of all migration steps, derived from the shared
 * MIGRATION_STEPS constant. We attach hub-side metadata (timeouts,
 * requiresWindow flag) here rather than baking it into the shared
 * constant, since these values are only relevant to the orchestrator.
 */
const STEPS: readonly MigrationStep[] = MIGRATION_STEPS.map((s) => ({
  number: s.number,
  name: s.name,
  executor: s.executor as AgentRole,
  timeoutMs: timeoutForStep(s.number),
  requiresWindow: s.number === 1 ? true : undefined,
}))

/** Look up a step by its 1-indexed number. Returns null for unknown steps. */
export function getStep(n: number): MigrationStep | null {
  return STEPS.find((s) => s.number === n) ?? null
}

/**
 * Returns the step that follows `currentStep`, or null if currentStep is
 * the last step (or unknown). Useful for the orchestrator's "advance"
 * loop in MIGRATING.
 */
export function nextStep(currentStep: number): MigrationStep | null {
  return STEPS.find((s) => s.number === currentStep + 1) ?? null
}

/**
 * Convenience accessor returning which agent should execute a given step.
 * Throws if the step number is invalid — callers should use getStep first
 * if they need a soft check.
 */
export function getExecutor(step: number): AgentRole {
  const s = getStep(step)
  if (!s) throw new Error(`Unknown migration step: ${step}`)
  return s.executor
}

/** Total number of migration steps (currently 9, per architecture v1.0). */
export const TOTAL_STEPS = STEPS.length

/**
 * Steps that require BOTH agents to participate (source sends an
 * encrypted payload, target receives + persists). The orchestrator
 * broadcasts execute_step to both agents and must wait for both
 * `agent:step_complete` acks before advancing — otherwise it would
 * dispatch the next step to target before target has finished
 * processing the relayed payload (race observed on step 5 → 6 where
 * target's step 6 ran before its step 5 await landed the keypair).
 */
export const BILATERAL_STEPS: ReadonlySet<number> = new Set([4, 5])

/** Re-export StepResult so callers can import from a single place. */
export type { StepResult }
