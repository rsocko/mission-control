import { describe, expect, it } from 'vitest';
import {
  appendQuickUpdate,
  formatQuickUpdateTimestamps,
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
      '- **2026-10-17 12:38 PM** — Called vendor',
    ].join('\n'));
  });

  it('formats quick update timestamps in 12-hour time', () => {
    expect(appendQuickUpdate(
      null,
      'Started early',
      new Date(2026, 9, 17, 0, 5),
    )).toContain('- **2026-10-17 12:05 AM**');
    expect(appendQuickUpdate(
      null,
      'Finished work',
      new Date(2026, 9, 17, 13, 23),
    )).toContain('- **2026-10-17 1:23 PM**');
  });

  it('formats existing 24-hour update timestamps for display only', () => {
    expect(formatQuickUpdateTimestamps([
      'Logged at 2026-10-20 13:23',
      '## Updates',
      '',
      '- **2026-10-20 13:23** — Traded VM with TJ',
      '- **2026-10-19 17:17** — Submitted form online',
      '',
      '## Reference',
      '',
      '- **2026-10-19 17:17** — Keep this note unchanged',
    ].join('\n'))).toBe([
      'Logged at 2026-10-20 13:23',
      '## Updates',
      '',
      '- **2026-10-20 1:23 PM** — Traded VM with TJ',
      '- **2026-10-19 5:17 PM** — Submitted form online',
      '',
      '## Reference',
      '',
      '- **2026-10-19 17:17** — Keep this note unchanged',
    ].join('\n'));
  });

  it('formats legacy updates when notes use Windows line endings', () => {
    expect(formatQuickUpdateTimestamps(
      '## Updates\r\n\r\n- **2026-10-20 00:10** — Started early',
    )).toBe('## Updates\r\n\r\n- **2026-10-20 12:10 AM** — Started early');
  });

  it('prepends the newest entry within an existing Updates section', () => {
    expect(appendQuickUpdate(
      '## Updates\n\n- **2026-10-14 09:12** — Submitted request\n\n## Reference\n\nCase 42',
      'Called vendor',
      new Date(2026, 9, 17, 12, 38),
    )).toContain([
      '## Updates',
      '',
      '- **2026-10-17 12:38 PM** — Called vendor',
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
