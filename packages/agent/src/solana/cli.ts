import { spawn } from 'node:child_process';

export interface RunSolanaCliOptions {
  timeoutMs?: number;
  cwd?: string;
}

export interface RunSolanaCliResult {
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
 * Spawns the local `solana` CLI binary with given args.
 * Throws SolanaCliError on non-zero exit, timeout, or spawn failure.
 */
export function runSolanaCli(
  args: string[],
  opts: RunSolanaCliOptions = {},
): Promise<RunSolanaCliResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd;

  return new Promise<RunSolanaCliResult>((resolve, reject) => {
    let child;
    try {
      child = spawn('solana', args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // NO_DNA=1 signals the Solana CLI we are a non-human operator:
        // disables interactive prompts, TUI, and prefers structured output.
        env: { ...process.env, NO_DNA: '1' },
      });
    } catch (err) {
      reject(
        new SolanaCliError(
          `Failed to spawn solana CLI: ${(err as Error).message}`,
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
      reject(
        new SolanaCliError(
          `solana CLI process error: ${err.message}`,
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
            `solana CLI timed out after ${timeoutMs}ms (args: ${args.join(' ')})`,
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
            `solana CLI exited with code ${exitCode} (args: ${args.join(' ')})`,
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
