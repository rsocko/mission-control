import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupTargets,
  orphanReason,
  processTree,
  processIdentity,
  readRecords,
  sameProcessIdentity,
  scanRegistry,
  selectSessionOwner,
  stopRegisteredProcess,
  summarizeRecord,
  validatePersistence,
  writeRecord,
} from '../../scripts/lib/dev-server-lifecycle.mjs';

const startedAt = '2026-08-06T20:00:00.000Z';

function processEntry(
  pid: number,
  parentPid: number,
  commandLine = `process-${pid}`,
  overrides = {},
) {
  return {
    pid,
    parentPid,
    commandLine,
    startedAt,
    memoryBytes: pid * 1024,
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    id: 'mission-control-3098-test',
    port: 3098,
    process: processEntry(100, 50, 'node next dev'),
    session: {
      id: 'session-1',
      ownerProcess: processEntry(50, 10, 'copilot cli'),
      worktree: 'C:\\dev\\worktree',
    },
    persistence: {
      mode: 'session',
      expiresAt: '2026-08-07T04:00:00.000Z',
    },
    ...overrides,
  };
}

describe('development server lifecycle safety', () => {
  it('builds a Windows process tree in leaves-first cleanup order', () => {
    const snapshot = {
      processes: [
        processEntry(100, 50, 'node next dev'),
        processEntry(101, 100, 'next-server'),
        processEntry(102, 101, 'worker'),
        processEntry(103, 100, 'watcher'),
        processEntry(999, 1, 'unrelated webview'),
      ],
      ports: new Map([[3098, 101]]),
    };

    expect(processTree(snapshot, 100).map((entry) => entry.pid)).toEqual([
      102, 101, 103, 100,
    ]);
    expect(cleanupTargets(record(), snapshot).map((entry) => entry.pid)).toEqual([
      102, 101, 103, 100,
    ]);
    expect(summarizeRecord(record(), snapshot)).toMatchObject({
      processTreePids: [102, 101, 103, 100],
      portOwnerPid: 101,
      portOwnedByTree: true,
    });
  });

  it('refuses cleanup after PID and port reuse by unrelated processes', () => {
    const reused = {
      processes: [
        processEntry(100, 1, 'unrelated node service', {
          startedAt: '2026-08-06T21:00:00.000Z',
        }),
        processEntry(200, 1, 'webview'),
      ],
      ports: new Map([[3098, 200]]),
    };

    expect(cleanupTargets(record(), reused)).toEqual([]);
    expect(summarizeRecord(record(), reused)).toMatchObject({
      processTreePids: [],
      portOwnerPid: 200,
      portOwnedByTree: false,
    });
  });

  it('requires matching creation time and command for an exact PID identity', () => {
    const expected = processEntry(100, 50, 'node next dev');
    expect(sameProcessIdentity(expected, { ...expected })).toBe(true);
    expect(
      sameProcessIdentity(expected, { ...expected, commandLine: 'node other.js' }),
    ).toBe(false);
    expect(
      sameProcessIdentity(expected, {
        ...expected,
        startedAt: '2026-08-06T20:00:03.000Z',
      }),
    ).toBe(false);
  });

  it('persists a command hash instead of command-line arguments', () => {
    const identity = processIdentity(
      processEntry(100, 50, 'node server.js --token secret'),
    );

    expect(identity).not.toHaveProperty('commandLine');
    expect(identity.commandHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      sameProcessIdentity(identity, processEntry(100, 50, 'node server.js --token secret')),
    ).toBe(true);
    expect(
      sameProcessIdentity(identity, processEntry(100, 50, 'node server.js --token other')),
    ).toBe(false);
  });

  it('detects an exited or replaced Copilot session owner', () => {
    const now = Date.parse('2026-08-06T21:00:00.000Z');
    const missingOwner = {
      processes: [processEntry(100, 50, 'node next dev')],
      ports: new Map(),
    };
    const reusedOwner = {
      processes: [
        processEntry(100, 50, 'node next dev'),
        processEntry(50, 10, 'another app', {
          startedAt: '2026-08-06T20:30:00.000Z',
        }),
      ],
      ports: new Map(),
    };

    expect(orphanReason(record(), missingOwner, now, true)).toBe(
      'owning session process exited',
    );
    expect(orphanReason(record(), reusedOwner, now, true)).toBe(
      'owning session process exited',
    );
    expect(orphanReason(record(), missingOwner, now, false)).toBe(
      'owning worktree no longer exists',
    );
  });

  it('expires a session server exactly at its safety TTL', () => {
    const snapshot = {
      processes: [
        processEntry(50, 10, 'copilot cli'),
        processEntry(100, 50, 'node next dev'),
      ],
      ports: new Map([[3098, 100]]),
    };
    const expiresAt = Date.parse('2026-08-07T04:00:00.000Z');

    expect(orphanReason(record(), snapshot, expiresAt - 1, true)).toBeNull();
    expect(orphanReason(record(), snapshot, expiresAt, true)).toBe(
      'session TTL expired',
    );
  });

  it('lets explicit durable servers outlive a session only until their TTL', () => {
    const durable = record({
      persistence: {
        mode: 'durable',
        owner: 'developer',
        purpose: 'shared UI review',
        expiresAt: '2026-08-06T22:00:00.000Z',
      },
    });
    const liveSnapshot = {
      processes: [processEntry(100, 50, 'node next dev')],
      ports: new Map(),
    };

    expect(
      orphanReason(
        durable,
        liveSnapshot,
        Date.parse('2026-08-06T21:00:00.000Z'),
        false,
      ),
    ).toBeNull();
    expect(
      orphanReason(
        durable,
        liveSnapshot,
        Date.parse('2026-08-06T22:00:00.000Z'),
        false,
      ),
    ).toBe('durable TTL expired');
  });

  it('detects a dead durable server before its TTL without targeting a reused PID', () => {
    const durable = record({
      persistence: {
        mode: 'durable',
        owner: 'developer',
        purpose: 'shared UI review',
        expiresAt: '2026-08-06T22:00:00.000Z',
      },
    });
    const reused = {
      processes: [
        processEntry(100, 1, 'unrelated process', {
          startedAt: '2026-08-06T20:30:00.000Z',
        }),
      ],
      ports: new Map(),
    };

    expect(
      orphanReason(
        durable,
        reused,
        Date.parse('2026-08-06T21:00:00.000Z'),
        true,
      ),
    ).toBe('registered process exited or PID was reused');
    expect(cleanupTargets(durable, reused)).toEqual([]);
  });

  it('rejects durable persistence without visible ownership metadata', () => {
    const base = {
      persistent: true,
      now: Date.parse(startedAt),
      ttlMinutes: 60,
      owner: 'developer',
      purpose: 'review',
    };
    expect(validatePersistence(base)).toMatchObject({
      mode: 'durable',
      owner: 'developer',
      purpose: 'review',
      expiresAt: '2026-08-06T21:00:00.000Z',
    });
    expect(() => validatePersistence({ ...base, owner: '' })).toThrow(
      '--owner',
    );
    expect(() => validatePersistence({ ...base, purpose: '' })).toThrow(
      '--purpose',
    );
    expect(() => validatePersistence({ ...base, ttlMinutes: 0 })).toThrow(
      '--ttl-minutes',
    );
  });

  it('selects the Copilot ancestor instead of an npm wrapper', () => {
    const snapshot = {
      processes: [
        processEntry(10, 1, 'copilot.exe --session abc'),
        processEntry(20, 10, 'powershell'),
        processEntry(30, 20, 'npm run dev'),
        processEntry(40, 30, 'node dev-server-manager.mjs'),
      ],
      ports: new Map(),
    };

    expect(selectSessionOwner(snapshot, 40, 30)?.pid).toBe(10);
  });

  it('never includes an unrelated port owner in kill targets', () => {
    const killProcess = vi.fn();
    const snapshot = {
      processes: [
        processEntry(100, 50, 'node next dev'),
        processEntry(101, 100, 'next-server'),
        processEntry(999, 1, 'unrelated node service'),
      ],
      ports: new Map([[3098, 999]]),
    };
    for (const target of cleanupTargets(record(), snapshot)) {
      killProcess(target.pid, 'SIGTERM');
    }

    expect(killProcess.mock.calls.map(([pid]) => pid)).toEqual([101, 100]);
    expect(killProcess).not.toHaveBeenCalledWith(999, expect.anything());
  });

  it('reports new descendants terminated during POSIX escalation', async () => {
    const initial = {
      processes: [
        processEntry(100, 50, 'node next dev'),
        processEntry(101, 100, 'next-server'),
      ],
      ports: new Map([[3098, 101]]),
    };
    const refreshed = {
      processes: [
        ...initial.processes,
        processEntry(102, 101, 'late worker'),
      ],
      ports: initial.ports,
    };
    const killProcess = vi.fn();

    await expect(
      stopRegisteredProcess(record(), initial, killProcess, {
        platform: 'linux',
        escalate: true,
        wait: vi.fn(async () => undefined),
        refreshSnapshot: vi.fn(async () => refreshed),
      }),
    ).resolves.toEqual([101, 100, 102]);
    expect(killProcess.mock.calls).toEqual([
      [101, 'SIGTERM'],
      [100, 'SIGTERM'],
      [102, 'SIGKILL'],
      [101, 'SIGKILL'],
      [100, 'SIGKILL'],
    ]);
  });

  it('surfaces an orphan with memory before exact-process cleanup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mc-dev-server-'));
    const orphan = {
      ...record(),
      version: 1,
      command: ['node', 'next'],
      processTreePids: [100],
      startedAt,
      lastHealthCheckAt: null,
      health: false,
      memoryBytes: 0,
      portOwnerPid: null,
    };
    const snapshot = {
      processes: [processEntry(100, 50, 'node next dev')],
      ports: new Map([[3098, 100]]),
    };
    const killProcess = vi.fn();
    const checkHealth = vi.fn(async () => true);
    const workspaceExists = vi.fn(async () => true);
    const warningAt = Date.parse('2026-08-06T21:00:00.000Z');

    try {
      await writeRecord(directory, orphan);
      const warning = await scanRegistry({
        directory,
        snapshot,
        now: warningAt,
        graceMs: 30_000,
        killProcess,
        checkHealth,
        workspaceExists,
      });
      expect(warning).toMatchObject([
        {
          state: 'warning',
          reason: 'owning session process exited',
          record: {
            memoryBytes: 100 * 1024,
            health: true,
            orphanDetectedAt: '2026-08-06T21:00:00.000Z',
          },
        },
      ]);
      expect(killProcess).not.toHaveBeenCalled();

      const cleaned = await scanRegistry({
        directory,
        snapshot,
        now: warningAt + 30_000,
        graceMs: 30_000,
        killProcess,
        checkHealth,
        workspaceExists,
      });
      expect(cleaned).toMatchObject([
        {
          state: 'cleaned',
          killedPids: [100],
        },
      ]);
      expect(killProcess).toHaveBeenCalledWith(100, 'SIGTERM');
      await expect(readRecords(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
