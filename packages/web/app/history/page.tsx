import { Suspense } from 'react'
import type { Session } from '@validator-shift/shared'
import { Badge } from '@/components/ui/Badge'

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:3001'

async function fetchAllSessions(): Promise<{
  sessions: Session[]
  reachable: boolean
}> {
  try {
    const res = await fetch(`${HUB_URL}/api/sessions?limit=50`, {
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

function formatDuration(ms: number): string {
  if (ms < 0) return '—'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m === 0) return `${s}s`
  return `${m}m ${s}s`
}

async function HistoryTable() {
  const { sessions, reachable } = await fetchAllSessions()
  if (!reachable) {
    return <p className="text-sm text-zinc-500 font-mono">Hub not reachable</p>
  }
  if (sessions.length === 0) {
    return (
      <p className="text-sm text-zinc-500 font-mono">No migrations recorded.</p>
    )
  }
  return (
    <div className="overflow-x-auto rounded border border-zinc-800">
      <table className="w-full text-sm font-mono">
        <thead className="bg-zinc-900/60 text-zinc-400">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Date</th>
            <th className="text-left px-4 py-2 font-medium">Code</th>
            <th className="text-left px-4 py-2 font-medium">State</th>
            <th className="text-left px-4 py-2 font-medium">Duration</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {sessions.map((s) => {
            const duration =
              typeof s.completedAt === 'number'
                ? formatDuration(s.completedAt - s.createdAt)
                : '—'
            return (
              <tr key={s.id} className="hover:bg-zinc-900/30">
                <td className="px-4 py-2 text-zinc-300">{formatTs(s.createdAt)}</td>
                <td className="px-4 py-2 text-zinc-200">{s.code}</td>
                <td className="px-4 py-2">
                  <Badge>{s.state}</Badge>
                </td>
                <td className="px-4 py-2 text-zinc-400">{duration}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function HistoryTableSkeleton() {
  return (
    <div className="rounded border border-zinc-800 p-4 space-y-2" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-6 bg-zinc-900 rounded animate-pulse" />
      ))}
    </div>
  )
}

export default function HistoryPage() {
  return (
    <>
      <h1 className="font-mono text-3xl font-bold text-term-green tracking-tight">
        Migration history
      </h1>
      <div className="mt-8">
        <Suspense fallback={<HistoryTableSkeleton />}>
          <HistoryTable />
        </Suspense>
      </div>
    </>
  )
}
