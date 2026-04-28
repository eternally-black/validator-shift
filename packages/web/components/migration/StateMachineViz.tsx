'use client'

import { motion } from 'framer-motion'
import { MigrationState } from '@validator-shift/shared'

interface StateMachineVizProps {
  state: MigrationState
}

const MAIN_CHAIN: MigrationState[] = [
  MigrationState.IDLE,
  MigrationState.PAIRING,
  MigrationState.PREFLIGHT,
  MigrationState.AWAITING_WINDOW,
  MigrationState.MIGRATING,
  MigrationState.COMPLETE,
]

const LABELS: Record<MigrationState, string> = {
  [MigrationState.IDLE]: 'Idle',
  [MigrationState.PAIRING]: 'Pairing',
  [MigrationState.PREFLIGHT]: 'Preflight',
  [MigrationState.AWAITING_WINDOW]: 'Awaiting Window',
  [MigrationState.MIGRATING]: 'Migrating',
  [MigrationState.COMPLETE]: 'Complete',
  [MigrationState.ROLLBACK]: 'Rollback',
  [MigrationState.FAILED]: 'Failed',
}

type NodeStatus = 'past' | 'current' | 'future'

function nodeStatus(node: MigrationState, current: MigrationState): NodeStatus {
  // ROLLBACK / FAILED do not advance the main chain.
  if (current === MigrationState.ROLLBACK || current === MigrationState.FAILED) {
    return 'future'
  }
  const currentIdx = MAIN_CHAIN.indexOf(current)
  const nodeIdx = MAIN_CHAIN.indexOf(node)
  if (currentIdx === -1 || nodeIdx === -1) return 'future'
  if (nodeIdx < currentIdx) return 'past'
  if (nodeIdx === currentIdx) return 'current'
  return 'future'
}

function MainNode({
  node,
  current,
}: {
  node: MigrationState
  current: MigrationState
}) {
  const status = nodeStatus(node, current)
  const label = LABELS[node]

  if (status === 'current') {
    return (
      <motion.div
        className="flex items-center gap-3 rounded-md border border-[#00FF41] bg-[#00FF41]/10 px-3 py-2 font-mono text-sm text-[#00FF41]"
        animate={{
          scale: [1, 1.04, 1],
          boxShadow: [
            '0 0 8px rgba(0,255,65,0.4)',
            '0 0 22px rgba(0,255,65,0.8)',
            '0 0 8px rgba(0,255,65,0.4)',
          ],
        }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      >
        <span className="h-2 w-2 rounded-full bg-[#00FF41]" />
        <span>{label}</span>
      </motion.div>
    )
  }

  if (status === 'past') {
    return (
      <div className="flex items-center gap-3 rounded-md border border-[#00FF41]/30 bg-transparent px-3 py-2 font-mono text-sm text-[#00FF41]/70">
        <span aria-hidden>✓</span>
        <span>{label}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 rounded-md border border-zinc-700 bg-transparent px-3 py-2 font-mono text-sm text-zinc-500">
      <span className="h-2 w-2 rounded-full bg-zinc-700" />
      <span>{label}</span>
    </div>
  )
}

function Connector({ active }: { active: boolean }) {
  return (
    <div
      className={`mx-auto my-1 h-4 w-px ${
        active ? 'bg-[#00FF41]/60' : 'bg-zinc-700'
      }`}
      aria-hidden
    />
  )
}

export function StateMachineViz({ state }: StateMachineVizProps) {
  const isErrorBranch =
    state === MigrationState.ROLLBACK || state === MigrationState.FAILED

  return (
    <div className="flex flex-col items-stretch">
      {MAIN_CHAIN.map((node, idx) => {
        const status = nodeStatus(node, state)
        const isLast = idx === MAIN_CHAIN.length - 1
        return (
          <div key={node} className="flex flex-col items-stretch">
            <MainNode node={node} current={state} />
            {!isLast && <Connector active={status === 'past'} />}
          </div>
        )
      })}

      {/* Error branch — drawn below the main chain */}
      <div className="mt-3 flex flex-col items-stretch">
        <div
          className={`mx-auto h-4 w-px ${
            isErrorBranch ? 'bg-[#FF3B3B]/70' : 'bg-zinc-800'
          }`}
          aria-hidden
        />
        {state === MigrationState.ROLLBACK ? (
          <motion.div
            className="flex items-center gap-3 rounded-md border border-[#FFB020] bg-[#FFB020]/10 px-3 py-2 font-mono text-sm text-[#FFB020]"
            animate={{
              opacity: [1, 0.6, 1],
              boxShadow: [
                '0 0 8px rgba(255,176,32,0.4)',
                '0 0 22px rgba(255,176,32,0.8)',
                '0 0 8px rgba(255,176,32,0.4)',
              ],
            }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <span className="h-2 w-2 rounded-full bg-[#FFB020]" />
            <span>{LABELS[MigrationState.ROLLBACK]}</span>
          </motion.div>
        ) : (
          <div
            className={`flex items-center gap-3 rounded-md border px-3 py-2 font-mono text-sm ${
              state === MigrationState.FAILED
                ? 'border-[#FF3B3B]/50 bg-[#FF3B3B]/10 text-[#FF3B3B]/80'
                : 'border-zinc-800 text-zinc-600'
            }`}
          >
            <span className="h-2 w-2 rounded-full bg-current opacity-60" />
            <span>{LABELS[MigrationState.ROLLBACK]}</span>
          </div>
        )}

        <div
          className={`mx-auto h-4 w-px ${
            state === MigrationState.FAILED ? 'bg-[#FF3B3B]/70' : 'bg-zinc-800'
          }`}
          aria-hidden
        />

        {state === MigrationState.FAILED ? (
          <motion.div
            className="flex items-center gap-3 rounded-md border border-[#FF3B3B] bg-[#FF3B3B]/10 px-3 py-2 font-mono text-sm text-[#FF3B3B]"
            animate={{
              scale: [1, 1.03, 1],
              boxShadow: [
                '0 0 8px rgba(255,59,59,0.4)',
                '0 0 22px rgba(255,59,59,0.8)',
                '0 0 8px rgba(255,59,59,0.4)',
              ],
            }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          >
            <span className="h-2 w-2 rounded-full bg-[#FF3B3B]" />
            <span>{LABELS[MigrationState.FAILED]}</span>
          </motion.div>
        ) : (
          <div className="flex items-center gap-3 rounded-md border border-zinc-800 px-3 py-2 font-mono text-sm text-zinc-600">
            <span className="h-2 w-2 rounded-full bg-zinc-700" />
            <span>{LABELS[MigrationState.FAILED]}</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default StateMachineViz
