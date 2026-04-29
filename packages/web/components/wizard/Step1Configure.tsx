'use client'

import { useCallback, useId, useMemo, useState } from 'react'
import { z } from 'zod'
import { Button, Card, Input } from '@/components/ui'
import { useSessionStore } from '@/lib/store'
import { MigrationState } from '@validator-shift/shared'

const ConfigSchema = z.object({
  ledgerPath: z.string().min(1, 'Ledger path is required'),
  keypairPath: z.string().min(1, 'Keypair path is required'),
  hubUrl: z.string().regex(/^wss?:\/\/.+/, 'Hub URL must start with ws:// or wss://'),
})

type ConfigFields = z.infer<typeof ConfigSchema>
type FieldErrors = Partial<Record<keyof ConfigFields, string>>

interface Step1Props {
  onNext: () => void
}

interface CreateSessionResponse {
  id: string
  code: string
  expiresAt: number
  dashboardToken: string
}

const HUB_API_URL = process.env.NEXT_PUBLIC_HUB_API_URL ?? ''

export function Step1Configure({ onNext }: Step1Props) {
  const ledgerId = useId()
  const keypairId = useId()
  const hubId = useId()

  const [fields, setFields] = useState<ConfigFields>({
    ledgerPath: '',
    keypairPath: '',
    hubUrl: 'ws://localhost:3002',
  })
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const validation = useMemo(() => ConfigSchema.safeParse(fields), [fields])
  const isValid = validation.success

  const fieldErrors: FieldErrors = useMemo(() => {
    if (validation.success) return {}
    const errors: FieldErrors = {}
    for (const issue of validation.error.issues) {
      const key = issue.path[0] as keyof ConfigFields | undefined
      if (key && !errors[key]) errors[key] = issue.message
    }
    return errors
  }, [validation])

  const updateField = useCallback(
    (key: keyof ConfigFields) => (value: string) => {
      setFields((prev) => ({ ...prev, [key]: value }))
    },
    [],
  )

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (!isValid || submitting) return

      setSubmitting(true)
      setSubmitError(null)
      try {
        const res = await fetch(`${HUB_API_URL}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (!res.ok) {
          throw new Error(`Failed to create session: ${res.status}`)
        }
        const data = (await res.json()) as CreateSessionResponse
        const store = useSessionStore.getState()
        store.setSession({
          id: data.id,
          code: data.code,
          expiresAt: data.expiresAt,
          state: MigrationState.IDLE,
          createdAt: Date.now(),
        })
        store.setDashboardToken(data.dashboardToken)
        onNext()
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setSubmitting(false)
      }
    },
    [isValid, submitting, onNext],
  )

  return (
    <Card>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ledgerId} className="text-sm font-mono text-neutral-400">
            Ledger path
          </label>
          <Input
            id={ledgerId}
            value={fields.ledgerPath}
            onChange={(e) => updateField('ledgerPath')(e.target.value)}
            placeholder="/mnt/ledger"
            aria-invalid={Boolean(fieldErrors.ledgerPath)}
          />
          {fieldErrors.ledgerPath && (
            <span className="text-xs text-red-400">{fieldErrors.ledgerPath}</span>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={keypairId} className="text-sm font-mono text-neutral-400">
            Keypair path
          </label>
          <Input
            id={keypairId}
            value={fields.keypairPath}
            onChange={(e) => updateField('keypairPath')(e.target.value)}
            placeholder="/home/sol/validator-keypair.json"
            aria-invalid={Boolean(fieldErrors.keypairPath)}
          />
          {fieldErrors.keypairPath && (
            <span className="text-xs text-red-400">{fieldErrors.keypairPath}</span>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={hubId} className="text-sm font-mono text-neutral-400">
            Hub URL
          </label>
          <Input
            id={hubId}
            value={fields.hubUrl}
            onChange={(e) => updateField('hubUrl')(e.target.value)}
            placeholder="wss://hub.example.com"
            aria-invalid={Boolean(fieldErrors.hubUrl)}
          />
          {fieldErrors.hubUrl && (
            <span className="text-xs text-red-400">{fieldErrors.hubUrl}</span>
          )}
        </div>

        {submitError && (
          <p role="alert" className="text-sm text-red-400">
            {submitError}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!isValid || submitting}>
            {submitting ? 'Creating session…' : 'Continue →'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

export default Step1Configure
