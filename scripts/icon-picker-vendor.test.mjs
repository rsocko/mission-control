import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  APPROVED_REGISTRY,
  CI_REGISTRY,
  LOCAL_REGISTRY,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SOURCE_COMMIT,
  SOURCE_TAG,
  verifySnapshot,
} from './icon-picker-vendor.mjs';

const source = resolve('vendor', 'icon-picker');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mc-icon-picker-'));
  const snapshot = join(root, 'snapshot');
  await cp(source, snapshot, { recursive: true });
  return {
    snapshot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('verifies the committed exact-commit package snapshot', async () => {
  const manifest = await verifySnapshot(source);
  assert.equal(manifest.source.commit, SOURCE_COMMIT);
  assert.equal(manifest.source.tag, SOURCE_TAG);
  assert.equal(manifest.package.name, PACKAGE_NAME);
  assert.equal(manifest.package.version, PACKAGE_VERSION);
  assert.equal(manifest.artifact.entryCount, 38);
  assert.equal(LOCAL_REGISTRY, 'https://packagefeedproxy.microsoft.io/npm/');
  assert.equal(CI_REGISTRY, 'https://registry.npmjs.org/');
  assert.equal(
    APPROVED_REGISTRY,
    process.env.GITHUB_ACTIONS === 'true' ? CI_REGISTRY : LOCAL_REGISTRY,
  );
});

test('ignores dependencies installed into the linked vendor package', async () => {
  const copy = await fixture();
  try {
    await mkdir(join(copy.snapshot, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(copy.snapshot, 'node_modules', '.bin', 'rolldown'), 'generated install artifact');
    await verifySnapshot(copy.snapshot);
  } finally {
    await copy.cleanup();
  }
});

test('rejects missing, extra, and tampered package files', async (context) => {
  await context.test('missing file', async () => {
    const copy = await fixture();
    try {
      await unlink(join(copy.snapshot, 'dist', 'core.js'));
      await assert.rejects(() => verifySnapshot(copy.snapshot), /allowlist/i);
    } finally {
      await copy.cleanup();
    }
  });

  await context.test('extra file', async () => {
    const copy = await fixture();
    try {
      await writeFile(join(copy.snapshot, 'editable-source.ts'), 'export {};\n');
      await assert.rejects(() => verifySnapshot(copy.snapshot), /allowlist/i);
    } finally {
      await copy.cleanup();
    }
  });

  await context.test('tampered file', async () => {
    const copy = await fixture();
    try {
      const path = join(copy.snapshot, 'dist', 'core.js');
      await writeFile(path, `${await readFile(path, 'utf8')}\n`);
      await assert.rejects(() => verifySnapshot(copy.snapshot), /SHA-256 mismatch/i);
    } finally {
      await copy.cleanup();
    }
  });
});

test('rejects rewritten provenance', async (context) => {
  await context.test('upstream manifest', async () => {
    const copy = await fixture();
    try {
      const path = join(copy.snapshot, 'UPSTREAM.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.source.commit = '0000000000000000000000000000000000000000';
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(() => verifySnapshot(copy.snapshot), /pinned upstream identity/i);
    } finally {
      await copy.cleanup();
    }
  });

  await context.test('snapshot manifest', async () => {
    const copy = await fixture();
    try {
      const path = join(copy.snapshot, 'icon-picker.snapshot.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.artifactSha256 = '0'.repeat(64);
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(() => verifySnapshot(copy.snapshot), /pinned package provenance/i);
    } finally {
      await copy.cleanup();
    }
  });
});

test('refuses synchronization without the reviewed exact commit', () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve('scripts', 'icon-picker-vendor.mjs'),
      'sync',
      '--commit',
      '0000000000000000000000000000000000000000',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match repository pin/i);
});

test('requires an explicit reviewable pin update for a different exact commit', () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve('scripts', 'icon-picker-vendor.mjs'),
      'sync',
      '--commit',
      '0'.repeat(40),
      '--update-pin',
      'false',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pass --update-pin true only when generating a reviewable update/i);
});
