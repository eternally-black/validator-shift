'use client'

import { useEffect, useRef } from 'react'
import type { LogEntry } from '@validator-shift/shared'
import { useSessionStore } from '@/lib/store'

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function agentColor(agent: LogEntry['agent']): string {
  switch (agent) {
    case 'source':
      return 'text-[#00FF41]'
    case 'target':
      return 'text-[#00FF41]/60'
    case 'hub':
      return 'text-[#FFB020]'
    default:
      return 'text-zinc-400'
  }
}

function levelColor(level: LogEntry['level']): string {
  switch (level) {
    case 'warn':
      return 'text-[#FFB020]'
    case 'error':
      return 'text-[#FF3B3B]'
    default:
      return 'text-zinc-200'
  }
}

export function LiveLogStream() {
  const logs = useSessionStore((s) => s.logs)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const stickyRef = useRef<boolean>(true)

  // Track whether the user is "stuck" near the bottom. If they scroll up,
  // suspend auto-scroll until they scroll back down.
  const onScroll = () => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickyRef.current = distanceFromBottom < 24
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (stickyRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs])

  return (
    <div className="flex h-full flex-col rounded-md border border-zinc-800 bg-black/60">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 font-mono text-xs uppercase tracking-wider text-zinc-500">
        <span>Live log</span>
        <span>{logs?.length ?? 0} entries</span>
      </div>
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
        style={{ maxHeight: 600 }}
      >
        {(!logs || logs.length === 0) && (
          <div className="text-zinc-600">— waiting for log entries —</div>
        )}
        {logs?.map((entry, i) => (
          <div
            key={`${entry.ts}-${entry.agent}-${i}`}
            className="whitespace-pre-wrap break-words"
          >
            <span className="text-zinc-500">{`<${formatTime(entry.ts)}>`}</span>{' '}
            <span className={agentColor(entry.agent)}>{`[${entry.agent}]`}</span>{' '}
            <span className={levelColor(entry.level)}>
              {entry.level}: {entry.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default LiveLogStream
