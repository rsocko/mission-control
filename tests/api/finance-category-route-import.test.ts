import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('finance category route module', () => {
  it('initializes without a circular connector factory dependency', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--conditions=react-server',
        '--import',
        'tsx',
        '--eval',
        "import('./src/app/api/finance/transactions/[id]/category/route.ts')",
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
