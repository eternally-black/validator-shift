'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import { useSessionStore } from '@/lib/store'

export function AbortButton() {
  const [confirming, setConfirming] = useState(false)

  const onAbort = () => {
    useSessionStore.getState().dispatch({ type: 'dashboard:abort' })
    setConfirming(false)
  }

  if (!confirming) {
    return (
      <Button
        variant="danger"
        onClick={() => setConfirming(true)}
        aria-label="Abort migration"
      >
        Abort
      </Button>
    )
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-[#FF3B3B]/40 bg-[#FF3B3B]/5 p-3"
      role="alertdialog"
      aria-label="Confirm abort"
    >
      <span className="font-mono text-sm text-[#FF3B3B]">Confirm abort?</span>
      <div className="flex items-center gap-2">
        <Button variant="danger" onClick={onAbort}>
          Yes, abort
        </Button>
        <Button onClick={() => setConfirming(false)}>Cancel</Button>
      </div>
    </div>
  )
}

export default AbortButton
