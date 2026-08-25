import { describe, expect, it } from 'vitest';
import { parseTaskInput } from '@/lib/parse-task-input';

describe('parseTaskInput planning horizons', () => {
  it.each([
    ['~now', 'now'],
    ['~next', 'next'],
    ['~later', 'later'],
    ['~someday', 'someday'],
  ] as const)('extracts %s', (token, expected) => {
    const result = parseTaskInput(`Write proposal ${token}`);

    expect(result.planningHorizon).toBe(expected);
    expect(result.title).toBe('Write proposal');
  });

  it('uses the last recognized horizon and removes every horizon token', () => {
    const result = parseTaskInput('Write proposal ~later then reconsider ~next');

    expect(result.planningHorizon).toBe('next');
    expect(result.title).toBe('Write proposal then reconsider');
  });

  it('does not confuse duration tokens with horizons', () => {
    const result = parseTaskInput('Write proposal ~30m ~now');

    expect(result.estimatedDuration).toBe(30);
    expect(result.planningHorizon).toBe('now');
  });

  it('preserves an escaped horizon as literal title text', () => {
    const result = parseTaskInput('Discuss \\~later naming');

    expect(result.planningHorizon).toBeNull();
    expect(result.title).toBe('Discuss ~later naming');
  });
});
