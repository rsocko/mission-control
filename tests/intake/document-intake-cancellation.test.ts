import { describe, expect, it } from 'vitest';
import { previewIntakeAsync } from '@/lib/intake/document-intake';

describe('document intake cancellation', () => {
  it('yields during deterministic parsing and stops when aborted', async () => {
    const controller = new AbortController();
    const content = Array.from({ length: 2_000 }, (_, index) => `- task ${index}`).join('\n');
    const parsing = previewIntakeAsync(content, {
      enableAI: false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 0);

    await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops while parsing a large audit table', async () => {
    const controller = new AbortController();
    const rows = Array.from(
      { length: 5_000 },
      (_, index) => `| F-${index} | API | Issue ${index} | Impact | Fix | Low |`,
    ).join('\n');
    const content = [
      '# Audit',
      '## Priority 1: Critical',
      '| ID | Area | Issue | Impact | Suggested Fix | Effort |',
      '| --- | --- | --- | --- | --- | --- |',
      rows,
    ].join('\n');
    const parsing = previewIntakeAsync(content, {
      enableAI: false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 0);

    await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
  });
});
