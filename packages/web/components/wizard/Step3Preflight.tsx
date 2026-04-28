'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { StatusDot } from '@/components/ui/StatusDot'
import { useSessionStore } from '@/lib/store'

interface Step3Props {
  onBack: () => void
}

export function Step3Preflight({ onBack }: Step3Props) {
  const router = useRouter()
  const preflight = useSessionStore((s) => s.preflight)
  const session = useSessionStore((s) => s.session)
  const allOk = useSessionStore((s) =>
    s.preflight.length > 0 && s.preflight.every((c) => c.ok),
  )

  const handleStart = useCallback(() => {
    if (!allOk || !session) return
    useSessionStore.getState().dispatch({ type: 'dashboard:start_migration' })
    router.push(`/session/${session.id}`)
  }, [allOk, session, router])

  const checks = preflight ?? []

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-mono uppercase tracking-wider text-neutral-400">
            Pre-flight Checks
          </h2>
          {checks.length === 0 ? (
            <p className="text-sm text-neutral-500">Awaiting checks from agents…</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {checks.map((c) => (
                <li key={c.name} className="flex flex-col gap-0.5">
                  <StatusDot status={c.ok ? 'ok' : 'error'}>{c.name}</StatusDot>
                  {c.detail && (
                    <span className="ml-5 text-xs text-neutral-500">{c.detail}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="secondary" onClick={onBack}>
          ← Back
        </Button>
        <Button variant="primary" onClick={handleStart} disabled={!allOk || !session}>
          Start Migration
        </Button>
      </div>
    </div>
  )
}

export default Step3Preflight
