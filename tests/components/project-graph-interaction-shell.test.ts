import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectPageSource = readFileSync(
  resolve(process.cwd(), 'src/app/projects/[id]/page.tsx'),
  'utf8',
);

describe('project graph interaction shell', () => {
  it('keeps project content interactive while task details are open', () => {
    expect(projectPageSource).not.toContain('inert={selectedTaskId');
    expect(projectPageSource).not.toContain('aria-hidden={selectedTaskId');
  });
});
