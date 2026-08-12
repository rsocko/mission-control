import { describe, it, expect } from 'vitest';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';

describe('isSyntheticTag', () => {
  it.each([
    'priority:critical',
    'priority:high',
    'priority:medium',
    'priority:low',
    'priority-high',
    'priority/medium',
    'priority_low',
    'priority high',
    'Priority:High',
    'priority',
    'Priority',
    'PRIORITY',
    'P0', 'P1', 'P2', 'P3',
    'p0', 'p1',
  ])('detects priority label: %s', (name) => {
    expect(isSyntheticTag(name)).toBe(true);
  });

  it.each([
    'effort:1', 'effort:5',
    'effort-xs', 'effort/m',
    'size:large', 'size-s',
    'estimate:3',
    't-shirt:xl',
  ])('detects effort label: %s', (name) => {
    expect(isSyntheticTag(name)).toBe(true);
  });

  it.each([
    'mc:in-research',
    'mc:blocked-external',
    'mc:waiting-on-someone',
    'mc:need-to-think',
    'mc:started-but-stuck',
    'mc:ready-but-unmotivated',
    'mc:done-needs-review',
  ])('detects known micro-status label: %s', (name) => {
    expect(isSyntheticTag(name)).toBe(true);
  });

  it.each([
    'mc:customer',
    'mc:internal',
    'mc:unknown-status',
  ])('passes through unknown mc: prefix: %s', (name) => {
    expect(isSyntheticTag(name)).toBe(false);
  });

  it.each([
    'bug',
    'enhancement',
    'type:feature',
    'area:tasks',
    'good first issue',
    'documentation',
    'help wanted',
    'area:mobile',
    'P4',
    'p5',
    'priorities',
  ])('keeps regular label: %s', (name) => {
    expect(isSyntheticTag(name)).toBe(false);
  });

  it('handles whitespace-padded names', () => {
    expect(isSyntheticTag('  priority:high  ')).toBe(true);
    expect(isSyntheticTag('  bug  ')).toBe(false);
  });
});
