import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process.spawn before importing the module under test.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { runSolanaCli, SolanaCliError } from './cli.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = vi.fn();
  return ee;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('runSolanaCli', () => {
  it('passes args to spawn and resolves on exit code 0', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runSolanaCli(['address']);

    // Simulate streamed output then clean exit.
    child.stdout.emit('data', Buffer.from('SomePubkey\n'));
    child.stderr.emit('data', Buffer.from(''));
    child.emit('close', 0);

    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('SomePubkey\n');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe('solana');
    expect(args).toEqual(['address']);
    expect(opts).toMatchObject({ shell: false });
  });

  it('rejects with SolanaCliError on non-zero exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runSolanaCli(['validators', '--output', 'json']);
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 2);

    await expect(promise).rejects.toBeInstanceOf(SolanaCliError);
    await expect(promise).rejects.toMatchObject({ code: 2, stderr: 'boom' });
  });

  it('honors timeoutMs and rejects with SolanaCliError', async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const promise = runSolanaCli(['gossip'], { timeoutMs: 50 });
      // Attach a catch handler immediately so an unhandled rejection isn't
      // reported while we advance fake timers.
      const assertion = expect(promise).rejects.toBeInstanceOf(SolanaCliError);

      vi.advanceTimersByTime(60);
      // Simulate the killed process closing after kill().
      child.emit('close', null);

      await assertion;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards cwd option to spawn', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runSolanaCli(['address'], { cwd: '/tmp/x' });
    child.emit('close', 0);
    await promise;

    expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: '/tmp/x' });
  });

  it('wraps spawn `error` events as SolanaCliError', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runSolanaCli(['address']);
    child.emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toBeInstanceOf(SolanaCliError);
  });
});
