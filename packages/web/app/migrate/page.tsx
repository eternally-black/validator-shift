'use client'

import { useCallback, useEffect, useState } from 'react'
import { WizardShell } from '@/components/wizard/WizardShell'
import { Step1Configure } from '@/components/wizard/Step1Configure'
import { Step2Connect } from '@/components/wizard/Step2Connect'
import { Step3Preflight } from '@/components/wizard/Step3Preflight'
import { useSessionStore } from '@/lib/store'
import { DashboardClient, wireClientToStore } from '@/lib/ws'

type WizardStep = 1 | 2 | 3

// Single hub URL; lib/ws.ts converts http(s) -> ws(s) for the WebSocket.
const HUB_URL = process.env.NEXT_PUBLIC_HUB_URL ?? 'http://localhost:3001'

export default function MigratePage() {
  const [step, setStep] = useState<WizardStep>(1)
  const sessionId = useSessionStore((s) => s.session?.id ?? null)
  const dashboardToken = useSessionStore((s) => s.dashboardToken)

  useEffect(() => {
    if (!sessionId || !dashboardToken) return

    const client = new DashboardClient({
      sessionId,
      hubUrl: HUB_URL,
      token: dashboardToken,
    })

    const unwire = wireClientToStore(client, useSessionStore)
    client.connect()

    return () => {
      client.disconnect()
      unwire?.()
    }
  }, [sessionId, dashboardToken])

  const goToStep2 = useCallback(() => setStep(2), [])
  const goToStep3 = useCallback(() => setStep(3), [])
  const goToStep1 = useCallback(() => setStep(1), [])
  const backToStep2 = useCallback(() => setStep(2), [])

  return (
    <div className="mx-auto w-full max-w-3xl py-10">
      <WizardShell currentStep={step}>
        {step === 1 && <Step1Configure onNext={goToStep2} />}
        {step === 2 && <Step2Connect onNext={goToStep3} onBack={goToStep1} />}
        {step === 3 && <Step3Preflight onBack={backToStep2} />}
      </WizardShell>
    </div>
  )
}
