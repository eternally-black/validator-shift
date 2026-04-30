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
    'base58 pubkey of the running validator (optional on source — derived from --keypair if omitted; preflight cross-checks against the running validator\'s JSON-RPC getIdentity response)',
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
  .option(
    '--insecure-ws',
    'allow plain ws:// to a non-localhost hub. Default refuses unless the hub host is localhost / 127.0.0.1.',
    false,
  )
  .option(
    '--unsafe-skip-wait-window',
    'SOURCE only: skip wait-for-restart-window. ONLY for single-validator localnets where the cluster halts the moment source switches identity. Bypasses the only safe handoff window check. NEVER use on testnet / mainnet.',
    false,
  )
  .option(
    '--unsafe-skip-quiet-gate',
    'TARGET only: skip the anti-dual-identity gate (waiting for source to stop voting before activating staked identity here). ONLY for single-validator localnets where the cluster halts and source never becomes delinquent. NEVER use on testnet / mainnet.',
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
      // --identity-pubkey is now optional: agent derives the pubkey from the
      // keypair file and cross-checks it against the running validator's
      // JSON-RPC getIdentity response in preflight.

      // H-3: refuse plaintext (http:// or ws://) to a non-loopback host.
      // SAS still detects MITM, but we should never normalize plaintext in prod.
      const hubUrl = String(raw.hub)
      const parsed = new URL(hubUrl)
      const isLoopback =
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '[::1]'
      const isPlaintext = parsed.protocol === 'ws:' || parsed.protocol === 'http:'
      const isSecure = parsed.protocol === 'wss:' || parsed.protocol === 'https:'
      if (!isPlaintext && !isSecure) {
        throw new Error(
          `--hub must use http(s):// or ws(s):// (got ${parsed.protocol})`,
        )
      }
      if (isPlaintext && !isLoopback && raw.insecureWs !== true) {
        throw new Error(
          `--hub uses plaintext ${parsed.protocol} to ${parsed.hostname}. Use https:// / wss:// or pass --insecure-ws (not recommended).`,
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
        unsafeSkipWaitWindow: Boolean(raw.unsafeSkipWaitWindow),
        unsafeSkipQuietGate: Boolean(raw.unsafeSkipQuietGate),
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
