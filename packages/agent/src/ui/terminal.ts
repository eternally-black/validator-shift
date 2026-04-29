import chalk from 'chalk'
import inquirer from 'inquirer'
import type { PreflightCheck } from '@validator-shift/shared'
import { MIGRATION_STEPS } from '@validator-shift/shared/constants'
import { redactSecrets } from '@validator-shift/shared/redact'

const PHOSPHOR = '#00FF41'
const AMBER = '#FFB000'
const MAX_WIDTH = 80

const green = chalk.hex(PHOSPHOR)
const amber = chalk.hex(AMBER)

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

/**
 * Operator confirmation prompt for destructive actions (set-identity,
 * authorized-voter changes, secure-wipe). Defaults to 'no' on ENTER.
 */
export async function confirmDestructive(message: string): Promise<boolean> {
  const { confirmed } = (await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: chalk.red.bold('⚠ ' + message),
      default: false,
    },
  ])) as { confirmed: boolean }
  return confirmed
}

export function printBanner(): void {
  const title = green.bold('VALIDATOR-SHIFT')
  const subtitle = chalk.dim('Solana validator identity transfer')
  // eslint-disable-next-line no-console
  console.log(title)
  // eslint-disable-next-line no-console
  console.log(subtitle)
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
  console.error(`${mark} ${chalk.red(redactSecrets(message))}`)
  if (extra) {
    // eslint-disable-next-line no-console
    console.error(chalk.dim(redactSecrets(extra)))
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
