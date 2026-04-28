'use client'

import { motion } from 'framer-motion'
import { MigrationState } from '@validator-shift/shared'

interface BigStatusProps {
  state: MigrationState
}

interface StatusDescriptor {
  label: string
  color: string
  pulse: boolean
}

function describe(state: MigrationState): StatusDescriptor {
  switch (state) {
    case MigrationState.IDLE:
    case MigrationState.PAIRING:
    case MigrationState.PREFLIGHT:
    case MigrationState.AWAITING_WINDOW:
      return { label: 'WAITING', color: '#FFB020', pulse: false }
    case MigrationState.MIGRATING:
      return { label: 'IN PROGRESS', color: '#00FF41', pulse: true }
    case MigrationState.COMPLETE:
      return { label: 'SUCCESS', color: '#00FF41', pulse: false }
    case MigrationState.ROLLBACK:
      return { label: 'ROLLBACK', color: '#FFB020', pulse: true }
    case MigrationState.FAILED:
      return { label: 'FAILED', color: '#FF3B3B', pulse: false }
    default:
      return { label: 'UNKNOWN', color: '#888888', pulse: false }
  }
}

export function BigStatus({ state }: BigStatusProps) {
  const { label, color, pulse } = describe(state)

  return (
    <div className="flex items-center justify-center py-6">
      <motion.div
        key={label}
        className="font-mono text-4xl md:text-5xl tracking-widest font-bold"
        style={{ color }}
        animate={
          pulse
            ? { opacity: [1, 0.55, 1], textShadow: [
                `0 0 12px ${color}`,
                `0 0 24px ${color}`,
                `0 0 12px ${color}`,
              ] }
            : { opacity: 1, textShadow: `0 0 12px ${color}` }
        }
        transition={
          pulse
            ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }
            : { duration: 0.3 }
        }
      >
        {label}
      </motion.div>
    </div>
  )
}

export default BigStatus
