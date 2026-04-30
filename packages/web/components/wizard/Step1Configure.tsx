'use client'

import { useCallback, useId, useMemo, useState } from 'react'
import { z } from 'zod'
import { Button, Card, Input } from '@/components/ui'
import { useSessionStore, type ClusterType } from '@/lib/store'
import { MigrationState } from '@validator-shift/shared'

const ConfigSchema = z.object({
  ledgerPath: z.string().min(1, 'Ledger path is required'),
  keypairPath: z.string().min(1, 'Keypair path is required'),
  clusterType: z.enum(['production', 'localnet-single']),
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

const HUB_URL = process.env.NEXT_PUBLIC_HUB_URL ?? ''

export function Step1Configure({ onNext }: Step1Props) {
  const ledgerId = useId()
  const keypairId = useId()
  const clusterProductionId = useId()
  const clusterLocalnetId = useId()

  const [fields, setFields] = useState<ConfigFields>({
    ledgerPath: '',
    keypairPath: '',
    clusterType: 'production',
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
    <K extends keyof ConfigFields>(key: K) =>
      (value: ConfigFields[K]) => {
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
        const res = await fetch(`${HUB_URL}/api/sessions`, {
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
        store.setConfig({
          ledgerPath: fields.ledgerPath,
          keypairPath: fields.keypairPath,
          clusterType: fields.clusterType,
        })
        onNext()
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setSubmitting(false)
      }
    },
    [fields.ledgerPath, fields.keypairPath, fields.clusterType, isValid, submitting, onNext],
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

        <fieldset className="flex flex-col gap-2.5 rounded border border-neutral-800 px-4 py-3">
          <legend className="px-2 text-sm font-mono text-neutral-400">Cluster</legend>
          <p className="-mt-1 text-xs text-neutral-500">
            Leave this on <em>Production</em> unless you&apos;re testing.
            The localnet toggle is here purely as a developer affordance —
            it adds the
            <code className="mx-1 text-neutral-300">--unsafe-skip-*</code>
            flags so a single-validator localnet (which would otherwise
            stall mid-migration) completes end-to-end without manual env-var
            tweaks. Not intended for any real cluster.
          </p>

          <label
            htmlFor={clusterProductionId}
            className="flex cursor-pointer items-start gap-3"
          >
            <input
              id={clusterProductionId}
              type="radio"
              name="clusterType"
              value="production"
              checked={fields.clusterType === 'production'}
              onChange={() => updateField('clusterType')('production' as ClusterType)}
              className="mt-1"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm text-neutral-200">
                Production cluster
              </span>
              <span className="text-xs text-neutral-500">
                Mainnet, testnet, devnet, or any multi-validator cluster.
              </span>
            </span>
          </label>

          <label
            htmlFor={clusterLocalnetId}
            className="flex cursor-pointer items-start gap-3"
          >
            <input
              id={clusterLocalnetId}
              type="radio"
              name="clusterType"
              value="localnet-single"
              checked={fields.clusterType === 'localnet-single'}
              onChange={() => updateField('clusterType')('localnet-single' as ClusterType)}
              className="mt-1"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm text-neutral-200">
                Single-validator localnet (test only)
              </span>
              <span className="text-xs text-neutral-500">
                A localnet where one validator holds all stake. Wizard adds
                <code className="mx-1 text-neutral-300">--unsafe-skip-*</code>
                flags so the migration completes despite the cluster halting
                mid-handoff.
              </span>
            </span>
          </label>

          {fields.clusterType === 'localnet-single' && (
            <div className="mt-1 rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              ⚠ <strong>Test environments only.</strong> The skip flags bypass
              the anti-dual-identity gate. Running against testnet or mainnet
              with these flags risks dual-signing — slashable on a real
              cluster. Switch back to <em>Production</em> before generating
              real-cluster commands.
            </div>
          )}
        </fieldset>

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
