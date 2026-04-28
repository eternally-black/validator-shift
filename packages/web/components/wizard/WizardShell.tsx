'use client'

import type { ReactNode } from 'react'
import clsx from 'clsx'

interface WizardShellProps {
  currentStep: 1 | 2 | 3
  children: ReactNode
}

const STEPS = [
  { number: 1, label: 'Configure' },
  { number: 2, label: 'Connect' },
  { number: 3, label: 'Pre-flight' },
] as const

export function WizardShell({ currentStep, children }: WizardShellProps) {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Migration Wizard</h1>
        <ol
          aria-label="Wizard progress"
          className="flex items-center gap-4"
        >
          {STEPS.map((step, idx) => {
            const isActive = step.number === currentStep
            const isComplete = step.number < currentStep
            return (
              <li key={step.number} className="flex items-center gap-3">
                <span
                  aria-current={isActive ? 'step' : undefined}
                  className={clsx(
                    'inline-flex h-3 w-3 rounded-full transition-colors',
                    isActive && 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]',
                    isComplete && 'bg-emerald-700',
                    !isActive && !isComplete && 'bg-neutral-700',
                  )}
                />
                <span
                  className={clsx(
                    'text-sm font-mono uppercase tracking-wider',
                    isActive ? 'text-emerald-400' : 'text-neutral-500',
                  )}
                >
                  {step.number}. {step.label}
                </span>
                {idx < STEPS.length - 1 && (
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'h-px w-8',
                      step.number < currentStep ? 'bg-emerald-700' : 'bg-neutral-800',
                    )}
                  />
                )}
              </li>
            )
          })}
        </ol>
      </header>
      <section>{children}</section>
    </div>
  )
}

export default WizardShell
