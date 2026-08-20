import { describe, expect, it } from 'vitest';
import {
  addRecentProjectId,
  getProjectIdFromPathname,
  MAX_RECENT_PROJECTS,
  parseRecentProjectIds,
} from '@/lib/navigation/recent-projects';

describe('recent project navigation', () => {
  it('moves the current project to the front and enforces the history limit', () => {
    const existing = Array.from({ length: MAX_RECENT_PROJECTS }, (_, index) => `proj-${index}`);

    expect(addRecentProjectId(existing, 'proj-new')).toEqual([
      'proj-new',
      ...existing.slice(0, MAX_RECENT_PROJECTS - 1),
    ]);
    expect(addRecentProjectId(existing, 'proj-2')).toEqual([
      'proj-2',
      'proj-0',
      'proj-1',
      'proj-3',
      'proj-4',
    ]);
  });

  it('sanitizes persisted values and rejects malformed storage', () => {
    expect(parseRecentProjectIds(JSON.stringify([
      ' proj-one ',
      'proj-one',
      null,
      '',
      'proj-two',
    ]))).toEqual(['proj-one', 'proj-two']);
    expect(parseRecentProjectIds('{not json')).toEqual([]);
    expect(parseRecentProjectIds(JSON.stringify({ id: 'proj-one' }))).toEqual([]);
  });

  it('extracts only valid project detail routes', () => {
    expect(getProjectIdFromPathname('/projects/proj-one')).toBe('proj-one');
    expect(getProjectIdFromPathname('/projects/proj%20one')).toBe('proj one');
    expect(getProjectIdFromPathname('/projects')).toBeNull();
    expect(getProjectIdFromPathname('/projects/%E0%A4%A')).toBeNull();
    expect(getProjectIdFromPathname('/today')).toBeNull();
  });
});
