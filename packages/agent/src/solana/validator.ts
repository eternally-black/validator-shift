import { runSolanaCli, SolanaCliError } from './cli.js';

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
 * Strategy:
 *  1. `solana address` → identity pubkey associated with the local CLI config.
 *     (TODO: prefer querying `solana-validator --ledger ... contact-info` once
 *     a stable JSON output for it is verified across all supported releases.)
 *  2. `solana gossip --output json` → check whether identity is in gossip.
 *  3. `solana validators --output json` → look up vote account / delinquency
 *     for the identity (best-effort; clusters may be very large).
 *
 * This function never throws — it returns safe defaults if parsing fails so
 * that callers can use it for diagnostics rather than control flow.
 */
export async function getValidatorInfo(): Promise<ValidatorInfo> {
  let identityPubkey = '';
  let voteAccount: string | null = null;
  let isVoting = false;
  let isCaughtUp = false;

  // Step 1: identity pubkey from local CLI config.
  try {
    const { stdout } = await runSolanaCli(['address']);
    identityPubkey = stdout.trim();
  } catch (err) {
    // TODO: fall back to reading the validator's --identity flag from the
    // running process' command line (platform-specific). For now, return
    // empty string so caller knows we couldn't determine it.
    if (!(err instanceof SolanaCliError)) throw err;
    return { identityPubkey: '', voteAccount: null, isVoting: false, isCaughtUp: false };
  }

  // Step 2: gossip check (caught-up ≈ present in gossip).
  try {
    const { stdout } = await runSolanaCli(['gossip', '--output', 'json']);
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      isCaughtUp = parsed.some(
        (entry: { identityPubkey?: string }) =>
          entry?.identityPubkey === identityPubkey,
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
    const match = list.find(v => v.identityPubkey === identityPubkey);
    if (match) {
      voteAccount = match.voteAccountPubkey ?? null;
      isVoting = match.delinquent === false && (match.lastVote ?? 0) > 0;
    }
  } catch {
    // TODO: `solana validators` payload shape can change between releases.
    // If parsing fails, leave voteAccount=null and isVoting=false.
  }

  return { identityPubkey, voteAccount, isVoting, isCaughtUp };
}

// ---------------------------------------------------------------------------
// Internal helper: invoke `solana-validator` instead of `solana`.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';

interface RunValidatorOpts {
  timeoutMs?: number;
}

function runSolanaValidator(
  args: string[],
  opts: RunValidatorOpts = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('solana-validator', args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(
        new SolanaCliError(
          `Failed to spawn solana-validator: ${(err as Error).message}`,
          -1,
          '',
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new SolanaCliError(
          `solana-validator process error: ${err.message}`,
          -1,
          stderr,
        ),
      );
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new SolanaCliError(
            `solana-validator timed out after ${timeoutMs}ms (args: ${args.join(' ')})`,
            code ?? -1,
            stderr,
          ),
        );
        return;
      }

      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        reject(
          new SolanaCliError(
            `solana-validator exited with code ${exitCode} (args: ${args.join(' ')})`,
            exitCode,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
  });
}
