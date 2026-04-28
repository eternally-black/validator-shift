'use client'

import { MIGRATION_STEPS } from '@validator-shift/shared/constants'
import { Spinner } from '@/components/ui'
import { useSessionStore } from '@/lib/store'

type StepStatus = 'pending' | 'running' | 'complete' | 'failed'

export interface StepListProps {
  /**
   * Optional override; if not provided, the list reads progress from the
   * session store. Index = step.number - 1.
   */
  steps?: StepStatus[]
}

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === 'running') {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center text-[#00FF41]">
        <Spinner />
      </span>
    )
  }
  if (status === 'complete') {
    return <span className="text-[#00FF41]" aria-label="complete">✓</span>
  }
  if (status === 'failed') {
    return <span className="text-[#FF3B3B]" aria-label="failed">✗</span>
  }
  return <span className="text-zinc-600" aria-label="pending">·</span>
}

function rowColor(status: StepStatus): string {
  switch (status) {
    case 'running':
      return 'text-[#00FF41]'
    case 'complete':
      return 'text-[#00FF41]/70'
    case 'failed':
      return 'text-[#FF3B3B]'
    default:
      return 'text-zinc-500'
  }
}

export function StepList({ steps }: StepListProps) {
  // Subscribe only to the slice we need so unrelated store updates do not
  // re-render this component (rerender-defer-reads).
  const storeSteps = useSessionStore((s) =>
    steps ? null : (s as unknown as { steps?: StepStatus[] }).steps ?? null,
  )

  const resolved: StepStatus[] =
    steps ??
    storeSteps ??
    (MIGRATION_STEPS.map(() => 'pending') as StepStatus[])

  return (
    <ul className="flex flex-col gap-1 font-mono text-sm">
      {MIGRATION_STEPS.map((step, idx) => {
        const status: StepStatus = resolved[idx] ?? 'pending'
        return (
          <li
            key={step.number}
            className={`flex items-center gap-3 rounded px-2 py-1 ${rowColor(status)}`}
          >
            <span className="w-6 text-right text-zinc-500">
              [{step.number}]
            </span>
            <span className="flex-1 truncate">{step.name}</span>
            <span className="text-xs uppercase tracking-wider">{status}</span>
            <StatusIcon status={status} />
          </li>
        )
      })}
    </ul>
  )
}

export default StepList
