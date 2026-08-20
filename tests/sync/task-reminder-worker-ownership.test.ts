import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('task reminder runtime ownership', () => {
  it('runs reminders in the worker with an inline web fallback', () => {
    const workerSource = readFileSync(
      path.join(process.cwd(), 'src', 'sync-worker.ts'),
      'utf8',
    );
    const webSource = readFileSync(
      path.join(process.cwd(), 'src', 'instrumentation.ts'),
      'utf8',
    );

    expect(workerSource).toContain("import('@/lib/push/task-reminder-scheduler')");
    expect(workerSource).toContain('await taskReminderScheduler.start()');
    expect(workerSource).toContain('taskReminderScheduler.stop()');
    expect(webSource).toContain('if (!durableSyncMode)');
    expect(webSource).toContain('await taskReminderScheduler.start()');
  });
});
