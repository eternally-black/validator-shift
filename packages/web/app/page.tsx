import { Suspense } from 'react'
import Link from 'next/link'
import type { Session } from '@validator-shift/shared'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:3001'

async function fetchRecentSessions(): Promise<{
  sessions: Session[]
  reachable: boolean
}> {
  try {
    const res = await fetch(`${HUB_URL}/api/sessions?limit=5`, {
      next: { revalidate: 5 },
    })
    if (!res.ok) return { sessions: [], reachable: false }
    const data = (await res.json()) as { sessions?: Session[] } | Session[]
    const sessions = Array.isArray(data) ? data : (data.sessions ?? [])
    return { sessions, reachable: true }
  } catch {
    return { sessions: [], reachable: false }
  }
}

function formatTs(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

async function RecentSessions() {
  const { sessions, reachable } = await fetchRecentSessions()
  if (!reachable) {
    return <p className="text-xs text-zinc-500 font-mono">Hub not running</p>
  }
  if (sessions.length === 0) {
    return (
      <p className="text-xs text-zinc-500 font-mono">
        No migrations yet — start your first one.
      </p>
    )
  }
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {sessions.map((s) => (
        <li key={s.id}>
          <Card>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm text-zinc-200">{s.code}</span>
              <Badge>{s.state}</Badge>
            </div>
            <div className="mt-2 text-xs text-zinc-500 font-mono">
              {formatTs(s.createdAt)}
            </div>
          </Card>
        </li>
      ))}
    </ul>
  )
}

function RecentSessionsSkeleton() {
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <li key={i}>
          <Card>
            <div className="h-5 w-16 bg-zinc-800 rounded animate-pulse" />
            <div className="mt-2 h-3 w-24 bg-zinc-900 rounded animate-pulse" />
          </Card>
        </li>
      ))}
    </ul>
  )
}

export default function DashboardPage() {
  return (
    <>
      <section className="py-12">
        <h1 className="font-mono text-4xl md:text-5xl font-bold text-term-green tracking-tight">
          Solana validator identity transfer
        </h1>
        <p className="mt-4 max-w-2xl text-zinc-400 text-lg">
          Secure end-to-end encrypted migration with full safety guarantees.
        </p>
        <div className="mt-8">
          <Link href="/migrate">
            <Button variant="primary">Start Migration →</Button>
          </Link>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="font-mono text-xl font-semibold text-zinc-200 mb-4">
          Recent migrations
        </h2>
        <Suspense fallback={<RecentSessionsSkeleton />}>
          <RecentSessions />
        </Suspense>
      </section>
    </>
  )
}
