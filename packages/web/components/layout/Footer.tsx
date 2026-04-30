const REPO_BASE = 'https://github.com/eternally-black/validator-shift'

const FOOTER_LINKS: Array<{ label: string; href: string }> = [
  { label: 'GitHub', href: REPO_BASE },
  { label: 'Security', href: `${REPO_BASE}/blob/main/docs/THREAT_MODEL.md` },
  { label: 'Recovery', href: `${REPO_BASE}/blob/main/docs/RECOVERY.md` },
  { label: 'License', href: `${REPO_BASE}/blob/main/LICENSE` },
]

export function Footer() {
  return (
    <footer className="mt-16 border-t border-zinc-800/80 bg-black/40">
      <div className="container mx-auto flex max-w-6xl flex-col gap-2 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="font-mono text-xs text-zinc-500">
          <span className="text-zinc-300">validator-shift</span>
          <span className="mx-2 text-zinc-700">·</span>
          <span>secure Solana validator identity transfer</span>
        </p>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-zinc-500">
          {FOOTER_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-[#00FF41]"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </footer>
  )
}

export default Footer
