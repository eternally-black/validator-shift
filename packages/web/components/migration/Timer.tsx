'use client'

import { useEffect, useState } from 'react'

interface TimerProps {
  startedAt: number | null
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function Timer({ startedAt }: TimerProps) {
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (startedAt === null) return
    const interval = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => clearInterval(interval)
  }, [startedAt])

  if (startedAt === null) {
    return (
      <div className="font-mono text-2xl text-zinc-500" aria-label="Elapsed time">
        —
      </div>
    )
  }

  return (
    <div
      className="font-mono text-2xl text-[#00FF41] tabular-nums"
      aria-label="Elapsed time"
    >
      {formatDuration(now - startedAt)}
    </div>
  )
}

export default Timer
