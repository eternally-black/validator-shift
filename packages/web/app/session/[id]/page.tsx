'use client'

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { MigrationState } from '@validator-shift/shared'
import { Card } from '@/components/ui'
import { useSessionStore } from '@/lib/store'
import { DashboardClient, wireClientToStore } from '@/lib/ws'
import { StateMachineViz } from '@/components/migration/StateMachineViz'
import { StepList } from '@/components/migration/StepList'
import { LiveLogStream } from '@/components/migration/LiveLogStream'
import { BigStatus } from '@/components/migration/BigStatus'
import { Timer } from '@/components/migration/Timer'
import { AbortButton } from '@/components/migration/AbortButton'

export default function SessionPage() {
  const { id } = useParams<{ id: string }>()

  // Subscribe only to the slices we need on this page (rerender-defer-reads).
  const state = useSessionStore(
    (s) =>
      (s as unknown as { state?: MigrationState }).state ?? MigrationState.IDLE,
  )
  const startedAt = useSessionStore(
    (s) => (s as unknown as { startedAt?: number | null }).startedAt ?? null,
  )

  useEffect(() => {
    if (!id) return
    const hubWsUrl =
      process.env.NEXT_PUBLIC_HUB_URL ?? 'ws://localhost:3002'
    const client = new DashboardClient({ sessionId: id, hubWsUrl })
    const detach = wireClientToStore(client, useSessionStore)
    client.connect()
    return () => {
      detach?.()
      client.disconnect()
    }
  }, [id])

  return (
    <main className="min-h-screen bg-[#0A0A0A] px-4 py-6 text-zinc-200">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="font-mono text-lg uppercase tracking-widest text-[#00FF41]">
              Live Migration
            </h1>
            <p className="font-mono text-xs text-zinc-500">
              Session {id ?? '—'}
            </p>
          </div>
          <Timer startedAt={startedAt} />
        </header>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Left column */}
          <div className="flex flex-col gap-4">
            <Card>
              <StateMachineViz state={state} />
            </Card>

            <Card>
              <BigStatus state={state} />
            </Card>

            <Card>
              <StepList />
            </Card>

            <div className="flex justify-end">
              <AbortButton />
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col">
            <Card className="flex-1">
              <LiveLogStream />
            </Card>
          </div>
        </div>
      </div>
    </main>
  )
}
