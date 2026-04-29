import { spawn } from 'node:child_process';

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class SolanaCliError extends Error {
  public code: number;
  public stderr: string;

  constructor(message: string, code: number, stderr: string) {
    super(message);
    this.name = 'SolanaCliError';
    this.code = code;
    this.stderr = stderr;
    Object.setPrototypeOf(this, SolanaCliError.prototype);
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Spawn a Solana binary (`solana` or `solana-validator`) with the given args.
 * Throws SolanaCliError on non-zero exit, timeout, or spawn failure.
 *
 * NO_DNA=1 is always set: signals to the Solana CLI that we are a non-human
 * operator (disables interactive prompts and TUI, prefers structured output).
 */
function runProcess(
  bin: 'solana' | 'solana-validator',
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd;

  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_DNA: '1' },
      });
    } catch (err) {
      reject(
        new SolanaCliError(
          `Failed to spawn ${bin}: ${(err as Error).message}`,
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
        // ignore — process may already have exited
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
      reject(new SolanaCliError(`${bin} process error: ${err.message}`, -1, stderr));
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new SolanaCliError(
            `${bin} timed out after ${timeoutMs}ms (args: ${args.join(' ')})`,
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
            `${bin} exited with code ${exitCode} (args: ${args.join(' ')})`,
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

/** Run the `solana` CLI binary. */
export function runSolanaCli(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runProcess('solana', args, opts);
}

/** Run the `solana-validator` binary (for ledger / set-identity / authorized-voter). */
export function runSolanaValidator(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runProcess('solana-validator', args, opts);
}

// Backwards-compatible aliases (interface names unchanged for callers / tests).
export type RunSolanaCliOptions = RunOptions;
export type RunSolanaCliResult = RunResult;
