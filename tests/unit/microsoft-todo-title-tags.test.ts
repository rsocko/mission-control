import { describe, expect, it } from 'vitest';
import { removeMicrosoftTodoTitleTag } from '@/lib/connectors/microsoft-todo/title-tags';

describe('removeMicrosoftTodoTitleTag', () => {
  it('normalizes a title after removing a spaced tag name', () => {
    expect(removeMicrosoftTodoTitleTag(
      'Review plan #NEEDS-TRIAGE  tomorrow',
      'NEEDS TRIAGE',
    )).toBe('Review plan tomorrow');
  });

  it('matches hashtags case-insensitively without removing a partial tag', () => {
    expect(removeMicrosoftTodoTitleTag(
      'Review #needs-triage-later #Needs-Triage',
      'needs-triage',
    )).toBe('Review #needs-triage-later');
  });
});
