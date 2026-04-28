'use client'

import { useCallback } from 'react'
import { MigrationState } from '@validator-shift/shared'
import { Button, Card, CodeBlock, StatusDot } from '@/components/ui'
import { useSessionStore } from '@/lib/store'

interface Step2Props {
  onNext: () => void
  onBack: () => void
}

export function Step2Connect({ onNext, onBack }: Step2Props) {
  const session = useSessionStore((s) => s.session)
  const agents = useSessionStore((s) => s.agents)
  const state = useSessionStore((s) => s.state)
  const sas = useSessionStore((s) => s.sas)

  const sourceConnected = agents?.source.connected ?? false
  const targetConnected = agents?.target.connected ?? false

  const handleMatch = useCallback(() => {
    useSessionStore.getState().dispatch({ type: 'dashboard:confirm_sas' })
    onNext()
  }, [onNext])

  const handleMismatch = useCallback(() => {
    const store = useSessionStore.getState()
    store.dispatch({ type: 'dashboard:abort' })
    store.reset()
    onBack()
  }, [onBack])

  if (!session) {
    return (
      <Card>
        <p className="text-sm text-neutral-400">No active session. Return to step 1.</p>
        <div className="mt-4">
          <Button variant="secondary" onClick={onBack}>
            ← Back
          </Button>
        </div>
      </Card>
    )
  }

  const showSas = state === MigrationState.PAIRING && sas !== null

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-mono uppercase tracking-wider text-neutral-400">
            Session Code
          </h2>
          <CodeBlock>{session.code}</CodeBlock>
          <p className="text-sm text-neutral-400">
            Run the agent on both servers using the code above.
          </p>
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-mono uppercase tracking-wider text-neutral-400">
            Launch Agents
          </h2>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-neutral-500">Source server:</span>
            <CodeBlock>{`npx @validator-shift/agent --role source --session ${session.code}`}</CodeBlock>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-neutral-500">Target server:</span>
            <CodeBlock>{`npx @validator-shift/agent --role target --session ${session.code}`}</CodeBlock>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-mono uppercase tracking-wider text-neutral-400">
            Agent Status
          </h2>
          <div className="flex flex-col gap-2">
            <StatusDot status={sourceConnected ? 'ok' : 'pending'}>
              Source — {sourceConnected ? 'connected' : 'waiting'}
            </StatusDot>
            <StatusDot status={targetConnected ? 'ok' : 'pending'}>
              Target — {targetConnected ? 'connected' : 'waiting'}
            </StatusDot>
          </div>
        </div>
      </Card>

      {showSas && (
        <Card>
          <div className="flex flex-col gap-4">
            <h2 className="text-sm font-mono uppercase tracking-wider text-neutral-400">
              SAS Verification
            </h2>
            <p className="text-sm text-neutral-400">
              Confirm the code below matches what is shown on both agent terminals.
            </p>
            <div className="rounded border border-emerald-700/40 bg-black/60 px-6 py-8 text-center font-mono text-3xl tracking-[0.4em] text-emerald-400">
              {sas}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button variant="primary" onClick={handleMatch}>
                Match — Continue
              </Button>
              <Button variant="danger" onClick={handleMismatch}>
                Mismatch — Abort
              </Button>
            </div>
          </div>
        </Card>
      )}

      <div>
        <Button variant="secondary" onClick={onBack}>
          ← Back
        </Button>
      </div>
    </div>
  )
}

export default Step2Connect
