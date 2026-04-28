'use client'

import clsx from 'clsx'
import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes } from 'react'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

const monoTriggerTypes = new Set(['path', 'code'])

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, id, type = 'text', className, ...rest },
  ref,
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const useMono = monoTriggerTypes.has(type)
  const htmlType = useMono ? 'text' : type

  return (
    <div className="flex flex-col gap-1 w-full">
      {label && (
        <label
          htmlFor={inputId}
          className="font-mono text-xs uppercase tracking-wider text-term-text-dim"
        >
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        type={htmlType}
        className={clsx(
          'bg-term-bg border rounded-md px-3 py-2 text-sm text-term-text outline-none transition-colors',
          'focus:border-term-green focus:shadow-term-glow',
          error ? 'border-term-red' : 'border-term-border',
          useMono && 'font-mono placeholder:font-mono',
          className,
        )}
        {...rest}
      />
      {error && (
        <span className="font-mono text-xs text-term-red">{error}</span>
      )}
    </div>
  )
})
