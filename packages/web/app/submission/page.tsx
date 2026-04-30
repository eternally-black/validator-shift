import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export const dynamic = 'force-static'
export const revalidate = false

export const metadata = {
  title: 'ValidatorShift — Bounty submission',
  description:
    'Colosseum bounty submission packet for ValidatorShift, the secure Solana validator identity migration tool.',
}

async function loadSubmissionMarkdown(): Promise<string> {
  // Resolve relative to this source file so the standalone build can find
  // the colocated markdown without depending on process.cwd() (which differs
  // between `next dev`, `next start`, and the standalone runtime).
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(here, 'submission.md'),
    path.join(process.cwd(), 'app/submission/submission.md'),
    path.join(process.cwd(), 'packages/web/app/submission/submission.md'),
  ]
  for (const p of candidates) {
    try {
      return await readFile(p, 'utf-8')
    } catch {
      // try next candidate
    }
  }
  throw new Error('submission.md not found in any expected location')
}

export default async function SubmissionPage() {
  const md = await loadSubmissionMarkdown()
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <article className="prose prose-invert prose-emerald max-w-none font-sans
        prose-headings:font-mono prose-headings:tracking-tight
        prose-h1:text-3xl prose-h1:mb-4
        prose-h2:text-xl prose-h2:mt-10 prose-h2:border-b prose-h2:border-neutral-800 prose-h2:pb-2
        prose-h3:text-base prose-h3:mt-6 prose-h3:text-neutral-300
        prose-h4:text-sm prose-h4:uppercase prose-h4:tracking-wider prose-h4:text-neutral-400
        prose-a:text-emerald-400 prose-a:no-underline hover:prose-a:underline
        prose-code:rounded prose-code:bg-neutral-900 prose-code:px-1.5 prose-code:py-0.5
        prose-code:text-emerald-300 prose-code:before:content-none prose-code:after:content-none
        prose-pre:rounded-md prose-pre:border prose-pre:border-neutral-800 prose-pre:bg-black
        prose-table:text-sm
        prose-th:border-neutral-800 prose-td:border-neutral-800
        prose-li:my-1
        prose-blockquote:border-l-emerald-700 prose-blockquote:text-neutral-400">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </article>
    </main>
  )
}
