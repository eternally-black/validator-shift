import clsx from 'clsx'
import type { HTMLAttributes, ReactNode } from 'react'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export interface CardTitleProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export interface CardBodyProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

function CardRoot({ children, className, ...rest }: CardProps) {
  return (
    <div
      className={clsx(
        'border border-term-border bg-term-surface rounded-md p-4',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

function CardTitle({ children, className, ...rest }: CardTitleProps) {
  return (
    <div
      className={clsx(
        'font-mono text-sm uppercase tracking-wider text-term-green mb-3',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

function CardBody({ children, className, ...rest }: CardBodyProps) {
  return (
    <div className={clsx('text-term-text text-sm', className)} {...rest}>
      {children}
    </div>
  )
}

export const Card = Object.assign(CardRoot, {
  Title: CardTitle,
  Body: CardBody,
})
