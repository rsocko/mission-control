import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { verifySnapshot } from './generic-graph-workbench-vendor.mjs';

const source = resolve('vendor', 'generic-graph-workbench');
const require = createRequire(import.meta.url);
const transformNodeNextTypeScript = require('./turbopack-node-next-source-loader.cjs');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mc-generic-graph-'));
  const snapshot = join(root, 'snapshot');
  await cp(source, snapshot, { recursive: true });
  return {
    snapshot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('verifies the committed pinned snapshot', async () => {
  const manifest = await verifySnapshot(source);
  assert.equal(manifest.source.commit, 'ed50b3b0313470540a58e1447e009c1620fe7f21');
  assert.equal(manifest.files.length, 31);
});

test('rejects missing, extra, and tampered payload files', async (context) => {
  await context.test('missing file', async () => {
    const copy = await fixture();
    try {
      await unlink(join(copy.snapshot, 'src', 'controllers', 'selection.ts'));
      await assert.rejects(
        () => verifySnapshot(copy.snapshot),
        /missing|exact public source closure|Unable to resolve/i,
      );
    } finally {
      await copy.cleanup();
    }
  });

  await context.test('extra file', async () => {
    const copy = await fixture();
    try {
      await writeFile(join(copy.snapshot, 'extra.ts'), 'export {};\n');
      await assert.rejects(() => verifySnapshot(copy.snapshot), /exactly match/i);
    } finally {
      await copy.cleanup();
    }
  });

  await context.test('tampered file', async () => {
    const copy = await fixture();
    try {
      const path = join(copy.snapshot, 'src', 'controllers', 'selection.ts');
      await writeFile(path, `${await readFile(path, 'utf8')}\n`);
      await assert.rejects(() => verifySnapshot(copy.snapshot), /SHA-256 mismatch/i);
    } finally {
      await copy.cleanup();
    }
  });
});

test('rejects provenance, export, canonical encoding, and closure drift', async (context) => {
  await context.test('rewritten payload hash forgery', async () => {
    const copy = await fixture();
    try {
      const sourcePath = 'src/controllers/selection.ts';
      const path = join(copy.snapshot, ...sourcePath.split('/'));
      const bytes = Buffer.from(`${await readFile(path, 'utf8')}\n`);
      await writeFile(path, bytes);
      const manifestPath = join(copy.snapshot, 'generic-graph-workbench.snapshot.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.files.find((file) => file.path === sourcePath).sha256 = createHash('sha256')
        .update(bytes)
        .digest('hex');
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(() => verifySnapshot(copy.snapshot), /pinned digest/i);
    } finally {
      await copy.cleanup();
    }
  });

  await context.test('wrong pinned commit', async () => {
    const copy = await fixture();
    try {
      const path = join(copy.snapshot, 'generic-graph-workbench.snapshot.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.source.commit = '0000000000000000000000000000000000000000';
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(() => verifySnapshot(copy.snapshot), /pinned digest/i);
    } finally {
      await copy.cleanup();
    }
  });

  test('transpiles NodeNext source imports for the pinned Next.js Turbopack build', () => {
    const output = transformNodeNextTypeScript.call(
      { resourcePath: 'vendor/generic-graph-workbench/src/example.ts' },
      'export * from "./local.js";\nexport { default as value } from "../core/index.js";\nexport const answer: number = 42;\n',
    );
    assert.match(output, /from "\.\/local"/);
    assert.match(output, /from "\.\.\/core\/index"/);
    assert.doesNotMatch(output, /: number/);
  });

  await context.test('wrong public export', async () => {
    const copy = await fixture();
    try {
      const path = join(copy.snapshot, 'generic-graph-workbench.snapshot.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.exports.pop();
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(() => verifySnapshot(copy.snapshot), /pinned digest/i);
    } finally {
      await copy.cleanup();
    }
  });

  await context.test('non-canonical manifest', async () => {
    const copy = await fixture();
    try {
      const path = join(copy.snapshot, 'generic-graph-workbench.snapshot.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify(manifest));
      await assert.rejects(() => verifySnapshot(copy.snapshot), /pinned digest/i);
    } finally {
      await copy.cleanup();
    }
  });

  await context.test('broken local import closure', async () => {
    const copy = await fixture();
    try {
      const path = join(copy.snapshot, 'src', 'controllers', 'index.ts');
      await writeFile(path, `${await readFile(path, 'utf8')}export * from "./missing.js";\n`);
      await assert.rejects(() => verifySnapshot(copy.snapshot), /Unable to resolve/i);
    } finally {
      await copy.cleanup();
    }
  });
});
