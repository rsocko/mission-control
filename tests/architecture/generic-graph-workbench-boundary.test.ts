import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as controllers from '@rsocko/generic-graph-canvas-shared-workbench/controllers';
import * as core from '@rsocko/generic-graph-canvas-shared-workbench/core';
import * as host from '@rsocko/generic-graph-canvas-shared-workbench/host';
import * as layout from '@rsocko/generic-graph-canvas-shared-workbench/layout';
import * as react from '@rsocko/generic-graph-canvas-shared-workbench/react';

const vendorRoot = resolve('vendor', 'generic-graph-workbench');
const manifest = JSON.parse(
  readFileSync(join(vendorRoot, 'generic-graph-workbench.snapshot.json'), 'utf8'),
) as {
  files: Array<{ path: string }>;
  source: { repository: string; commit: string };
};

describe('generic graph workbench boundary', () => {
  it('loads all five declared public source exports', () => {
    expect(core.GraphHistory).toBeTypeOf('function');
    expect(host.defineGraphHostAdapter).toBeTypeOf('function');
    expect(controllers.GraphDocumentController).toBeTypeOf('function');
    expect(layout.createLayeredHierarchyLayout).toBeTypeOf('function');
    expect(react.GraphCanvasRegion).toBeTypeOf('function');
  });

  it('pins the exact merged Ideation provider', () => {
    expect(manifest.source).toEqual({
      repository: 'https://github.com/rsocko/ideation',
      commit: 'ed50b3b0313470540a58e1447e009c1620fe7f21',
    });
  });

  it('contains no imports from Mission Control application layers', () => {
    const sourceFiles = manifest.files
      .map(({ path }) => path)
      .filter((path) => path.endsWith('.ts') || path.endsWith('.tsx'));
    for (const path of sourceFiles) {
      const source = readFileSync(join(vendorRoot, path), 'utf8');
      const specifiers = [...source.matchAll(/\b(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)]
        .map((match) => match[1]);
      expect(specifiers, path).not.toContainEqual(expect.stringMatching(/^@\//));
      expect(specifiers, path).not.toContainEqual(expect.stringMatching(/mission-control/i));
      for (const specifier of specifiers.filter((value) => value.startsWith('.'))) {
        expect(resolve(dirname(join(vendorRoot, path)), specifier).startsWith(vendorRoot), path)
          .toBe(true);
      }
    }
  });
});
