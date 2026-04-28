import clsx from 'clsx'
import type { HTMLAttributes, ReactNode } from 'react'

export type BadgeVariant = 'success' | 'warning' | 'error' | 'info'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
  children: ReactNode
}

const variantClasses: Record<BadgeVariant, string> = {
  success: 'bg-term-green-glow text-term-green border-term-green',
  warning: 'bg-term-amber/10 text-term-amber border-term-amber',
  error: 'bg-term-red/10 text-term-red border-term-red',
  info: 'bg-term-surface text-term-text-dim border-term-border',
}

export function Badge({
  variant = 'info',
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center font-mono text-xs uppercase tracking-wider px-2 py-0.5 rounded border',
        variantClasses[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  )
}
