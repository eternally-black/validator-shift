import clsx from 'clsx'
import { MigrationState } from '@validator-shift/shared'

export interface StepperProps {
  currentState: MigrationState
  completedStates?: MigrationState[]
  className?: string
}

interface StepDef {
  state: MigrationState
  label: string
}

const STEPS: readonly StepDef[] = [
  { state: MigrationState.IDLE, label: 'Idle' },
  { state: MigrationState.PAIRING, label: 'Pairing' },
  { state: MigrationState.PREFLIGHT, label: 'Preflight' },
  { state: MigrationState.AWAITING_WINDOW, label: 'Awaiting Window' },
  { state: MigrationState.MIGRATING, label: 'Migrating' },
  { state: MigrationState.COMPLETE, label: 'Complete' },
] as const

export function Stepper({
  currentState,
  completedStates,
  className,
}: StepperProps) {
  const currentIndex = STEPS.findIndex((s) => s.state === currentState)
  const completedSet = new Set(completedStates ?? [])

  return (
    <ol
      className={clsx(
        'flex flex-col gap-2 font-mono text-sm',
        className,
      )}
    >
      {STEPS.map((step, idx) => {
        const isCurrent = step.state === currentState
        const isCompletedExplicit = completedSet.has(step.state)
        const isCompletedImplicit =
          currentIndex >= 0 && idx < currentIndex
        const isCompleted = isCompletedExplicit || isCompletedImplicit
        const isFuture = !isCurrent && !isCompleted

        return (
          <li
            key={step.state}
            className={clsx(
              'flex items-center gap-3 px-3 py-2 rounded transition-colors',
              isCurrent &&
                'font-bold text-term-green shadow-term-glow border border-term-green/40 bg-term-green-glow',
              isCompleted &&
                !isCurrent &&
                'text-term-green-dim',
              isFuture && 'text-term-text-dim',
            )}
            aria-current={isCurrent ? 'step' : undefined}
          >
            <span
              aria-hidden="true"
              className={clsx(
                'inline-flex w-5 justify-center',
                isCompleted && !isCurrent && 'text-term-green-dim',
              )}
            >
              {isCompleted && !isCurrent
                ? '✓'
                : isCurrent
                  ? '>'
                  : String(idx + 1).padStart(2, '0')}
            </span>
            <span className="uppercase tracking-wider">{step.label}</span>
          </li>
        )
      })}
    </ol>
  )
}
