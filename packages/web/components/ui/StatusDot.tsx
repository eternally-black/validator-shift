import clsx from 'clsx'

export type StatusDotStatus = 'ok' | 'warn' | 'error' | 'pending'

export interface StatusDotProps {
  status: StatusDotStatus
  className?: string
  pulse?: boolean
  label?: string
  children?: React.ReactNode
}

const statusClasses: Record<StatusDotStatus, string> = {
  ok: 'bg-term-green shadow-term-glow',
  warn: 'bg-term-amber',
  error: 'bg-term-red',
  pending: 'bg-term-text-dim',
}

export function StatusDot({ status, className, pulse, label, children }: StatusDotProps) {
  const dot = (
    <span
      role="status"
      aria-label={label ?? status}
      className={clsx(
        'inline-block rounded-full',
        statusClasses[status],
        pulse && 'animate-pulse',
        !children && className,
      )}
      style={{ width: 8, height: 8 }}
    />
  )
  if (!children) return dot
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      {dot}
      <span>{children}</span>
    </span>
  )
}
