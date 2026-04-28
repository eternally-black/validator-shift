#!/usr/bin/env node
import { Command } from 'commander'
import { runAgent, type AgentOpts } from './commands/agent.js'
import { printError } from './ui/terminal.js'

const program = new Command()

program
  .name('validator-shift')
  .description('Validator-Shift: secure Solana validator identity migration')

program
  .command('agent')
  .description('Run the migration agent on a source or target server')
  .requiredOption('--role <role>', 'agent role: "source" or "target"')
  .requiredOption('--session <code>', 'pairing session code')
  .requiredOption('--hub <wssUrl>', 'hub WebSocket URL (wss://...)')
  .requiredOption('--ledger <path>', 'absolute path to the validator ledger')
  .option(
    '--keypair <path>',
    'path to the staked identity keypair (required on source)',
  )
  .option(
    '--unstaked-keypair <path>',
    'path for the unstaked keypair on source (optional; generated to tmp if omitted)',
  )
  .action(async (raw: Record<string, string | undefined>) => {
    try {
      if (raw.role !== 'source' && raw.role !== 'target') {
        throw new Error(`invalid --role "${String(raw.role)}" (expected source|target)`)
      }
      if (raw.role === 'source' && !raw.keypair) {
        throw new Error('--keypair is required when --role=source')
      }

      const opts: AgentOpts = {
        role: raw.role,
        session: String(raw.session),
        hub: String(raw.hub),
        ledger: String(raw.ledger),
        keypair: raw.keypair,
        unstakedKeypair: raw.unstakedKeypair,
      }

      await runAgent(opts)
    } catch (err) {
      printError(err)
      process.exit(1)
    }
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  printError(err)
  process.exit(1)
})
