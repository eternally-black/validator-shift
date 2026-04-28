import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import inquirer from 'inquirer'
import type { PreflightCheck, MigrationSummary } from '@validator-shift/shared'
import { MIGRATION_STEPS } from '@validator-shift/shared/constants'

const PHOSPHOR = '#00FF41'
const AMBER = '#FFB000'
const MAX_WIDTH = 80

const green = chalk.hex(PHOSPHOR)
const amber = chalk.hex(AMBER)

function pad(str: string, width: number): string {
  if (str.length >= width) return str
  return str + ' '.repeat(width - str.length)
}

function truncate(str: string, width: number): string {
  if (str.length <= width) return str
  if (width <= 1) return str.slice(0, width)
  return str.slice(0, width - 1) + '…'
}

function formatTime(d: Date = new Date()): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m${s}s`
}

export function printBanner(): void {
  const title = green.bold('VALIDATOR-SHIFT')
  const subtitle = chalk.dim('Solana validator identity transfer')
  // eslint-disable-next-line no-console
  console.log(title)
  // eslint-disable-next-line no-console
  console.log(subtitle)
}

export function spinnerFor(label: string): Ora {
  return ora({ text: label, color: 'green' })
}

export function printPreflightTable(checks: PreflightCheck[]): void {
  for (const c of checks) {
    const mark = c.ok ? green('✓') : chalk.red('✗')
    const detail = c.detail ? ` ${chalk.dim('— ' + c.detail)}` : ''
    // Reserve space: "[X] " (4) + name + " — detail" — keep total ≤ MAX_WIDTH
    const prefixLen = 4 // "[X] "
    const detailRawLen = c.detail ? c.detail.length + 3 : 0 // " — " + detail
    const nameMax = Math.max(8, MAX_WIDTH - prefixLen - detailRawLen)
    const name = truncate(c.name, nameMax)
    // eslint-disable-next-line no-console
    console.log(`[${mark}] ${name}${detail}`)
  }
}

export async function confirmSAS(sas: string): Promise<boolean> {
  const inner = ` ${sas} `
  const width = Math.min(MAX_WIDTH, Math.max(inner.length + 4, 24))
  const top = '╔' + '═'.repeat(width - 2) + '╗'
  const bottom = '╚' + '═'.repeat(width - 2) + '╝'
  const padding = width - 2 - inner.length
  const left = Math.floor(padding / 2)
  const right = padding - left
  const middle = '║' + ' '.repeat(left) + inner + ' '.repeat(right) + '║'
  const blank = '║' + ' '.repeat(width - 2) + '║'

  // eslint-disable-next-line no-console
  console.log(green(top))
  // eslint-disable-next-line no-console
  console.log(green(blank))
  // eslint-disable-next-line no-console
  console.log(green.bold(middle))
  // eslint-disable-next-line no-console
  console.log(green(blank))
  // eslint-disable-next-line no-console
  console.log(green(bottom))

  const answer = await inquirer.prompt<{ matches: boolean }>([
    {
      type: 'confirm',
      name: 'matches',
      message: 'SAS matches on the other agent?',
      default: false,
    },
  ])
  return answer.matches
}

export function printStepProgress(
  step: number,
  label: string,
  total: number = MIGRATION_STEPS.length,
): void {
  const line = `[${step}/${total}] ${label}`
  // eslint-disable-next-line no-console
  console.log(green.bold(line))
}

export function printError(err: unknown): void {
  const mark = chalk.red('✗')
  let message: string
  let extra: string | undefined

  if (err instanceof Error) {
    message = err.message
    const cause = (err as Error & { cause?: unknown }).cause
    const stderr = (err as Error & { stderr?: unknown }).stderr
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      extra = stderr.trim()
    } else if (cause !== undefined && cause !== null) {
      extra =
        cause instanceof Error
          ? cause.message
          : typeof cause === 'string'
            ? cause
            : JSON.stringify(cause)
    }
  } else if (typeof err === 'string') {
    message = err
  } else {
    message = JSON.stringify(err)
  }

  // eslint-disable-next-line no-console
  console.error(`${mark} ${chalk.red(message)}`)
  if (extra) {
    // eslint-disable-next-line no-console
    console.error(chalk.dim(extra))
  }
}

export function printSuccess(summary: MigrationSummary): void {
  // eslint-disable-next-line no-console
  console.log(`${green('✓')} ${green.bold('MIGRATION COMPLETE')}`)

  const rows: Array<[string, string]> = [
    ['duration', formatDuration(summary.durationMs)],
    ['source pubkey', summary.sourcePubkey ?? '—'],
    ['target pubkey', summary.targetPubkey ?? '—'],
    ['steps', String(summary.stepsCompleted)],
  ]

  const labelWidth = Math.max(...rows.map(([k]) => k.length))
  for (const [k, v] of rows) {
    const valueMax = Math.max(8, MAX_WIDTH - labelWidth - 3)
    const value = truncate(v, valueMax)
    // eslint-disable-next-line no-console
    console.log(`  ${chalk.dim(pad(k, labelWidth))}  ${value}`)
  }
}

export type LogLevel = 'info' | 'warn' | 'error'

export function printLog(level: LogLevel, message: string): void {
  const ts = formatTime()
  let tag: string
  switch (level) {
    case 'warn':
      tag = amber('[warn]')
      break
    case 'error':
      tag = chalk.red('[error]')
      break
    case 'info':
    default:
      tag = '[info]'
      break
  }
  // eslint-disable-next-line no-console
  console.log(`${chalk.dim(ts)} ${tag} ${message}`)
}
