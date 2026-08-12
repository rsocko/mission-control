import { describe, expect, it } from 'vitest';
import { parseTaskInput } from '@/lib/parse-task-input';

const projects = [
  { id: 'project-web', name: 'Website Redesign' },
  { id: 'project-api', name: 'API' },
];

describe('parseTaskInput project tokens', () => {
  it('resolves the longest matching +Project name', () => {
    const result = parseTaskInput('Ship homepage +Website Redesign !high', { projects });

    expect(result.project).toBe('Website Redesign');
    expect(result.projectId).toBe('project-web');
    expect(result.title).toBe('Ship homepage');
  });

  it('supports quoted project names without a project cache', () => {
    const result = parseTaskInput('Ship homepage +"Website Redesign"');

    expect(result.project).toBe('Website Redesign');
    expect(result.projectId).toBeNull();
    expect(result.title).toBe('Ship homepage');
  });

  it('does not treat numeric increments as project tokens', () => {
    const result = parseTaskInput('Got +1 vote');

    expect(result.project).toBeNull();
    expect(result.title).toBe('Got +1 vote');
  });
});
