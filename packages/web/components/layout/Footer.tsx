export function Footer() {
  return (
    <footer className="border-t border-zinc-800 bg-black">
      <div className="container mx-auto max-w-6xl px-6 py-4">
        <p className="font-mono text-xs text-zinc-500">
          validator-shift —{' '}
          <a
            href="https://github.com/Eternally-black/validator-shift"
            className="hover:text-term-green underline-offset-2 hover:underline transition-colors"
          >
            GitHub
          </a>
        </p>
      </div>
    </footer>
  )
}

export default Footer
