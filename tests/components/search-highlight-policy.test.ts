import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const searchCommand = readFileSync(
  resolve(process.cwd(), 'src/components/search/SearchCommand.tsx'),
  'utf8',
);

describe('search result highlight policy', () => {
  it('uses a solid high-contrast treatment for matched text', () => {
    const markElement = searchCommand.match(/<mark[\s\S]*?>/)?.[0];

    expect(searchCommand).toContain(
      'className="rounded-[4px] bg-yellow-300 px-0.5 font-semibold text-yellow-950"',
    );
    expect(markElement).toBeDefined();
    expect(markElement).not.toMatch(/bg-yellow-\d+\/\d+/);
  });
});
