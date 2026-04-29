import { runSolanaCli, runSolanaValidator, SolanaCliError } from './cli.js';

export interface WaitForRestartWindowOptions {
  minIdleTime?: number;
  skipNewSnapshotCheck?: boolean;
}

export interface ValidatorInfo {
  identityPubkey: string;
  voteAccount: string | null;
  isVoting: boolean;
  isCaughtUp: boolean;
}

/**
 * Wraps `solana-validator -l <ledger> wait-for-restart-window`.
 * This command can take a long time — caller should pass a generous timeout if needed.
 */
export async function waitForRestartWindow(
  ledger: string,
  opts: WaitForRestartWindowOptions = {},
): Promise<void> {
  const minIdleTime = opts.minIdleTime ?? 2;
  const args: string[] = [
    '-l',
    ledger,
    'wait-for-restart-window',
    '--min-idle-time',
    String(minIdleTime),
  ];
  if (opts.skipNewSnapshotCheck) {
    args.push('--skip-new-snapshot-check');
  }
  // wait-for-restart-window is part of `solana-validator`, not `solana`.
  // We use runSolanaValidator helper below.
  await runSolanaValidator(args, { timeoutMs: 30 * 60 * 1000 });
}

/**
 * Wraps `solana-validator -l <ledger> set-identity <keypair>`.
 */
export async function setIdentity(
  ledger: string,
  keypairPath: string,
): Promise<void> {
  await runSolanaValidator([
    '-l',
    ledger,
    'set-identity',
    '--require-tower',
    keypairPath,
  ]);
}

/**
 * Wraps `solana-validator -l <ledger> authorized-voter add <keypair>`.
 */
export async function addAuthorizedVoter(
  ledger: string,
  keypairPath: string,
): Promise<void> {
  await runSolanaValidator([
    '-l',
    ledger,
    'authorized-voter',
    'add',
    keypairPath,
  ]);
}

/**
 * Wraps `solana-validator -l <ledger> authorized-voter remove-all`.
 */
export async function removeAllAuthorizedVoters(ledger: string): Promise<void> {
  await runSolanaValidator(['-l', ledger, 'authorized-voter', 'remove-all']);
}

/**
 * Best-effort discovery of the running validator's identity and voting state.
 *
 * If `identityPubkey` is provided (recommended — pass --identity-pubkey on the
 * source CLI), it is used as the source of truth: this avoids the trap where
 * `solana address` returns the operator's CLI default keypair which may NOT
 * match the running validator's --identity flag.
 *
 * If omitted, falls back to `solana address` for backward compatibility, but
 * callers should treat the result with suspicion in production.
 *
 * This function never throws — it returns safe defaults if parsing fails so
 * that callers can use it for diagnostics rather than control flow.
 */
export async function getValidatorInfo(
  identityPubkey?: string,
): Promise<ValidatorInfo> {
  let resolvedIdentity = identityPubkey ?? '';
  let voteAccount: string | null = null;
  let isVoting = false;
  let isCaughtUp = false;

  if (!resolvedIdentity) {
    // Fallback: identity pubkey from local CLI config. Unsafe in production —
    // this returns the operator's default keypair, not necessarily the running
    // validator's --identity. Caller should pass identityPubkey explicitly.
    try {
      const { stdout } = await runSolanaCli(['address']);
      resolvedIdentity = stdout.trim();
    } catch (err) {
      if (!(err instanceof SolanaCliError)) throw err;
      return { identityPubkey: '', voteAccount: null, isVoting: false, isCaughtUp: false };
    }
  }

  // Step 2: gossip check (caught-up ≈ present in gossip).
  try {
    const { stdout } = await runSolanaCli(['gossip', '--output', 'json']);
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      isCaughtUp = parsed.some(
        (entry: { identityPubkey?: string }) =>
          entry?.identityPubkey === resolvedIdentity,
      );
    }
  } catch {
    // TODO: older Solana versions may not support `--output json` for gossip.
    // Leave isCaughtUp = false; caller should treat as unknown.
  }

  // Step 3: validators list — find vote account + voting status.
  try {
    const { stdout } = await runSolanaCli([
      'validators',
      '--output',
      'json',
    ]);
    const parsed = JSON.parse(stdout) as {
      validators?: Array<{
        identityPubkey?: string;
        voteAccountPubkey?: string;
        delinquent?: boolean;
        lastVote?: number;
      }>;
    };
    const list = parsed?.validators ?? [];
    const match = list.find(v => v.identityPubkey === resolvedIdentity);
    if (match) {
      voteAccount = match.voteAccountPubkey ?? null;
      isVoting = match.delinquent === false && (match.lastVote ?? 0) > 0;
    }
  } catch {
    // TODO: `solana validators` payload shape can change between releases.
    // If parsing fails, leave voteAccount=null and isVoting=false.
  }

  return { identityPubkey: resolvedIdentity, voteAccount, isVoting, isCaughtUp };
}

// runSolanaValidator (the `solana-validator` binary) is now exported from
// ./cli.ts — it shares the spawn/timeout/error machinery with runSolanaCli.
