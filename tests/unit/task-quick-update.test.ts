import { describe, expect, it } from 'vitest';
import {
  appendQuickUpdate,
  inferQuickUpdate,
} from '@/components/task-detail/task-quick-update';

describe('task quick updates', () => {
  it('appends a new Updates section without replacing existing notes', () => {
    expect(appendQuickUpdate(
      'Case: SB-849221',
      'Called vendor',
      new Date(2026, 9, 17, 12, 38),
    )).toBe([
      'Case: SB-849221',
      '',
      '## Updates',
      '',
      '- **2026-10-17 12:38** — Called vendor',
    ].join('\n'));
  });

  it('prepends the newest entry within an existing Updates section', () => {
    expect(appendQuickUpdate(
      '## Updates\n\n- **2026-10-14 09:12** — Submitted request\n\n## Reference\n\nCase 42',
      'Called vendor',
      new Date(2026, 9, 17, 12, 38),
    )).toContain([
      '## Updates',
      '',
      '- **2026-10-17 12:38** — Called vendor',
      '',
      '- **2026-10-14 09:12** — Submitted request',
    ].join('\n'));
  });

  it('infers a due date and concise follow-up from natural language', () => {
    expect(inferQuickUpdate(
      'Called vendor; check back Friday',
      new Date(2026, 9, 17, 12, 0),
    )).toEqual({
      dueDate: '2026-10-23',
      dueDateLabel: 'Friday',
      subtaskTitle: 'Check back',
    });
  });
});
