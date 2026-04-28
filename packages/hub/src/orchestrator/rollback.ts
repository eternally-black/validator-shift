import type { AgentRole } from '@validator-shift/shared'

/**
 * A single rollback action, as defined in the architecture document
 * (section 4.3). Rollback steps are emitted as instructions to the
 * appropriate agent — the orchestrator does not run them itself.
 */
export interface RollbackStep {
  name: string
  executor: AgentRole
  description: string
}

/**
 * Canonical rollback sequence (section 4.3 of the architecture):
 *
 *   1. Restore staked identity on SOURCE
 *   2. Re-add authorized voter on SOURCE
 *   3. Remove any transferred files from TARGET
 *   4. Verify SOURCE is voting normally
 *
 * The order matters: source must be voting again before we tell the
 * target to drop its (never-fully-activated) state, and the verify
 * step is always last so we can confidently mark the session FAILED.
 */
const ROLLBACK_SEQUENCE: readonly RollbackStep[] = [
  {
    name: 'restore_source_identity',
    executor: 'source',
    description: 'Restore staked identity on SOURCE (set-identity <staked-keypair>)',
  },
  {
    name: 'readd_authorized_voter_source',
    executor: 'source',
    description: 'Re-add authorized voter on SOURCE (authorized-voter add)',
  },
  {
    name: 'remove_transferred_files_target',
    executor: 'target',
    description: 'Remove any transferred tower / keypair files from TARGET',
  },
  {
    name: 'verify_source_voting',
    executor: 'source',
    description: 'Verify SOURCE is voting normally (gossip + vote credits)',
  },
]

/**
 * Step 1 (`wait_for_restart_window`) is purely a wait — no validator
 * state has been mutated yet, so failing it does NOT require rollback.
 * Any failure on step 2 or later means the source has been at least
 * partially deactivated, so a rollback IS required.
 */
export function shouldRollback(failedStep: number): boolean {
  return failedStep >= 2
}

/**
 * Returns the rollback steps to execute given the step at which the
 * migration failed. Per architecture v1.0, we always run the full
 * 4-step rollback sequence regardless of how far we got — there's no
 * harm in re-asserting the source's identity, and the verify step
 * gives us a definitive "source is healthy" signal.
 *
 * Returns an empty array if rollback isn't required (step 1 failure).
 */
export function getRollbackSteps(failedAtStep: number): RollbackStep[] {
  if (!shouldRollback(failedAtStep)) return []
  return [...ROLLBACK_SEQUENCE]
}

/** Exposed for tests / dashboards. */
export const ROLLBACK_STEPS: readonly RollbackStep[] = ROLLBACK_SEQUENCE
