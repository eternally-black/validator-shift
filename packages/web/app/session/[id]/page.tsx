'use client'

import { useEffect } from 'react'
import dynamic from 'next/dynamic'
import { useParams } from 'next/navigation'
import { Card } from '@/components/ui/Card'
import { useSessionStore } from '@/lib/store'
import { DashboardClient, wireClientToStore } from '@/lib/ws'
import { StepList } from '@/components/migration/StepList'
import { LiveLogStream } from '@/components/migration/LiveLogStream'
import { Timer } from '@/components/migration/Timer'
import { AbortButton } from '@/components/migration/AbortButton'

const StateMachineViz = dynamic(
  () => import('@/components/migration/StateMachineViz').then((m) => m.StateMachineViz),
  { ssr: false, loading: () => <div className="h-32 animate-pulse bg-zinc-900 rounded" /> },
)
const BigStatus = dynamic(
  () => import('@/components/migration/BigStatus').then((m) => m.BigStatus),
  { ssr: false, loading: () => <div className="h-24 animate-pulse bg-zinc-900 rounded" /> },
)

export default function SessionPage() {
  const { id } = useParams<{ id: string }>()

  const state = useSessionStore((s) => s.state)
  const startedAt = useSessionStore((s) => s.summary?.startedAt ?? null)
  const dashboardToken = useSessionStore((s) => s.dashboardToken)

  useEffect(() => {
    if (!id || !dashboardToken) return
    const hubUrl = process.env.NEXT_PUBLIC_HUB_URL ?? 'http://localhost:3001'
    const client = new DashboardClient({ sessionId: id, hubUrl, token: dashboardToken })
    const detach = wireClientToStore(client, useSessionStore)
    client.connect()
    return () => {
      detach?.()
      client.disconnect()
    }
  }, [id, dashboardToken])

  return (
    <div className="text-zinc-200">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-mono text-lg uppercase tracking-widest text-[#00FF41]">
            Live Migration
          </h1>
          <p className="font-mono text-xs text-zinc-500">Session {id ?? '—'}</p>
        </div>
        <Timer startedAt={startedAt} />
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
        <div className="flex flex-col">
          <Card className="flex-1">
            <LiveLogStream />
          </Card>
        </div>
      </div>
    </div>
  )
}
