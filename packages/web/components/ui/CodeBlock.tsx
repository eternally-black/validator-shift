import clsx from 'clsx'
import type { HTMLAttributes, ReactNode } from 'react'

export interface CodeBlockProps extends HTMLAttributes<HTMLPreElement> {
  children: ReactNode
}

export function CodeBlock({ children, className, ...rest }: CodeBlockProps) {
  return (
    <pre
      className={clsx(
        'font-mono text-xs leading-relaxed bg-term-surface border border-term-border rounded-md p-4 overflow-x-auto text-term-text whitespace-pre-wrap break-words',
        className,
      )}
      {...rest}
    >
      {children}
    </pre>
  )
}
