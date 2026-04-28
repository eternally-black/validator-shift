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
  .option(
    '--identity-pubkey <pk>',
    'base58 pubkey of the running validator (required on source — DO NOT rely on `solana address` which returns the operator default keypair)',
  )
  .option(
    '--skip-snapshot-check',
    'pass --skip-new-snapshot-check to wait-for-restart-window (default off; only enable for known-good snapshots)',
    false,
  )
  .option(
    '-y, --yes',
    'auto-confirm destructive operations (set-identity, authorized-voter, secure-wipe). Use only in fully attended automation.',
    false,
  )
  .action(async (raw: Record<string, string | boolean | undefined>) => {
    try {
      if (raw.role !== 'source' && raw.role !== 'target') {
        throw new Error(`invalid --role "${String(raw.role)}" (expected source|target)`)
      }
      if (raw.role === 'source' && !raw.keypair) {
        throw new Error('--keypair is required when --role=source')
      }
      if (raw.role === 'source' && !raw.identityPubkey) {
        throw new Error(
          '--identity-pubkey is required when --role=source (must match the running validator\'s --identity flag)',
        )
      }

      const opts: AgentOpts = {
        role: raw.role,
        session: String(raw.session),
        hub: String(raw.hub),
        ledger: String(raw.ledger),
        keypair: raw.keypair as string | undefined,
        unstakedKeypair: raw.unstakedKeypair as string | undefined,
        identityPubkey: raw.identityPubkey as string | undefined,
        skipSnapshotCheck: Boolean(raw.skipSnapshotCheck),
        yes: Boolean(raw.yes),
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
