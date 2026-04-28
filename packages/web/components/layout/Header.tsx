import Link from 'next/link'

export function Header() {
  return (
    <header className="border-b border-zinc-800 bg-black">
      <div className="container mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <span className="font-mono text-term-green" aria-hidden="true">
            ↦
          </span>
          <span className="font-mono font-bold text-term-green">
            VALIDATOR-SHIFT
          </span>
        </Link>
        <nav className="flex items-center gap-6 font-mono text-sm">
          <Link
            href="/"
            className="text-zinc-300 hover:text-term-green transition-colors"
          >
            Dashboard
          </Link>
          <Link
            href="/migrate"
            className="text-zinc-300 hover:text-term-green transition-colors"
          >
            Migrate
          </Link>
          <Link
            href="/history"
            className="text-zinc-300 hover:text-term-green transition-colors"
          >
            History
          </Link>
        </nav>
      </div>
    </header>
  )
}

export default Header
