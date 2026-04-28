import type { ReactNode } from 'react'

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div>
      <main className="container mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  )
}

export default PageShell
