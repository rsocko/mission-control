import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIRECTORY = join(ROOT, 'vendor', 'icon-picker');
const UPSTREAM_MANIFEST = 'UPSTREAM.json';
const SNAPSHOT_MANIFEST = 'icon-picker.snapshot.json';
const SOURCE_REPOSITORY = 'https://github.com/rsocko/icon-picker.git';
const SOURCE_COMMIT = '7206bbe8dc22d43d95b2e2c3c0020215efb8a2b9';
const APPROVED_REGISTRY = 'https://packagefeedproxy.microsoft.io/npm/';
const PACKAGE_NAME = '@rsocko/icon-picker';
const PACKAGE_VERSION = '0.1.0-rc.0';
const PINNED_NPM_VERSION = '11.19.0';
const ARTIFACT = Object.freeze({
  filename: 'rsocko-icon-picker-0.1.0-rc.0.tgz',
  size: 39695,
  unpackedSize: 126787,
  entryCount: 36,
  integrity: 'sha512-SVLC5q+B6vuWVabZgm2V6ugfiec8kLEhIBgl/+lZDZrsLWtUn6HucMNm2iBRx+l8GgEwXf8gAmklfrHOddtV8w==',
  shasum: '0b2db4385f35f5636b324285bd219b5c3310c8fe',
  sha256: '822dfdf28a4f8419c778d1e56b00d9628bcbe93918b672a9921c1eeb0ab921be',
  sha512: '4952c2e6af81eafb9655a6d9826d95eae81f89e73c90b121201825ffe9590d9aec2d6b549fa1ee70c366da2051c7e97c1a01305dff200269257eb1ce75db55f3',
});
const PACKAGE_EXPORTS = Object.freeze({
  '.': {
    types: './dist/index.d.ts',
    import: './dist/index.js',
  },
  './core': {
    types: './dist/core.d.ts',
    import: './dist/core.js',
  },
  './renderer': {
    types: './dist/renderer.d.ts',
    import: './dist/renderer.js',
  },
  './picker': {
    types: './dist/picker.d.ts',
    import: './dist/picker.js',
  },
  './styles.css': './dist/styles.css',
  './package.json': './package.json',
});

function fail(message) {
  throw new Error(message);
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? ROOT,
    encoding: options.encoding ?? 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string'
      ? result.stderr.trim()
      : result.stderr?.toString('utf8').trim();
    fail(detail || `${command} ${arguments_.join(' ')} failed`);
  }
  return result.stdout;
}

function runNpm(arguments_, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return run(process.execPath, [npmCli, ...arguments_], options);
  }
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', arguments_, options);
}

function runPinnedNpm(arguments_, options = {}) {
  return runNpm(
    [
      'exec',
      '--yes',
      `--package=npm@${PINNED_NPM_VERSION}`,
      '--',
      'npm',
      ...arguments_,
    ],
    options,
  );
}

function hash(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest('hex');
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} contains missing or unknown fields`);
  }
}

function assertSafePath(path) {
  if (
    typeof path !== 'string'
    || path.length === 0
    || path.startsWith('/')
    || path.startsWith('\\')
    || path.includes('\\')
    || path.split('/').some((part) => part === '.' || part === '..')
  ) {
    fail(`Package path escapes the vendor root: ${String(path)}`);
  }
}

async function listFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (current === root && entry.name === 'node_modules') continue;
    const absolutePath = join(current, entry.name);
    const snapshotPath = relative(root, absolutePath).split(sep).join('/');
    if (entry.isSymbolicLink()) fail(`Snapshot contains a symbolic link: ${snapshotPath}`);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolutePath));
    } else if (entry.isFile()) {
      files.push(snapshotPath);
    } else {
      fail(`Snapshot contains an unsupported filesystem entry: ${snapshotPath}`);
    }
  }
  return files.sort();
}

function validateManifest(manifest, bytes) {
  assertExactKeys(
    manifest,
    [
      'acquisition',
      'artifact',
      'canonicalization',
      'package',
      'schemaVersion',
      'source',
    ],
    UPSTREAM_MANIFEST,
  );
  assertExactKeys(manifest.package, ['name', 'version'], 'package provenance');
  assertExactKeys(manifest.source, ['commit', 'repository', 'tag'], 'source provenance');
  assertExactKeys(
    manifest.canonicalization,
    ['artifactContract', 'lineEndings'],
    'artifact canonicalization',
  );
  assertExactKeys(
    manifest.artifact,
    [
      'entryCount',
      'filename',
      'files',
      'integrity',
      'sha256',
      'sha512',
      'shasum',
      'size',
      'unpackedSize',
    ],
    'artifact provenance',
  );
  if (
    manifest.schemaVersion !== 1
    || manifest.package.name !== PACKAGE_NAME
    || manifest.package.version !== PACKAGE_VERSION
    || manifest.source.repository !== `git+${SOURCE_REPOSITORY}`
    || manifest.source.commit !== SOURCE_COMMIT
    || manifest.source.tag !== null
    || manifest.acquisition !== 'canonical-npm-pack-from-source'
    || manifest.canonicalization.lineEndings !== 'lf'
    || manifest.canonicalization.artifactContract !== 'package-artifact.json'
  ) {
    fail(`${UPSTREAM_MANIFEST} does not match the pinned upstream identity`);
  }
  for (const [key, value] of Object.entries(ARTIFACT)) {
    if (manifest.artifact[key] !== value) {
      fail(`${UPSTREAM_MANIFEST} artifact ${key} does not match the pinned value`);
    }
  }
  if (
    !Array.isArray(manifest.artifact.files)
    || manifest.artifact.files.length !== ARTIFACT.entryCount
    || JSON.stringify(manifest.artifact.files)
      !== JSON.stringify([...manifest.artifact.files].sort())
    || new Set(manifest.artifact.files).size !== manifest.artifact.files.length
  ) {
    fail(`${UPSTREAM_MANIFEST} package file allowlist must be unique and sorted`);
  }
  manifest.artifact.files.forEach(assertSafePath);
  const canonical = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (!canonical.equals(bytes)) fail(`${UPSTREAM_MANIFEST} is not canonically encoded`);
}

function validatePackageManifest(packageManifest) {
  if (
    packageManifest.name !== PACKAGE_NAME
    || packageManifest.version !== PACKAGE_VERSION
    || packageManifest.private === true
    || packageManifest.type !== 'module'
    || JSON.stringify(packageManifest.exports) !== JSON.stringify(PACKAGE_EXPORTS)
  ) {
    fail('Vendored package.json does not match the pinned package identity and exports');
  }
}

async function createSnapshotManifest(snapshotRoot, upstream) {
  const files = [];
  for (const path of upstream.artifact.files) {
    files.push({
      path,
      sha256: hash(await readFile(join(snapshotRoot, ...path.split('/'))), 'sha256'),
    });
  }
  return {
    schemaVersion: 1,
    package: upstream.package,
    source: upstream.source,
    artifactSha256: upstream.artifact.sha256,
    files,
  };
}

function validateSnapshotManifest(snapshot, upstream) {
  assertExactKeys(
    snapshot,
    ['artifactSha256', 'files', 'package', 'schemaVersion', 'source'],
    SNAPSHOT_MANIFEST,
  );
  if (
    snapshot.schemaVersion !== 1
    || JSON.stringify(snapshot.package) !== JSON.stringify(upstream.package)
    || JSON.stringify(snapshot.source) !== JSON.stringify(upstream.source)
    || snapshot.artifactSha256 !== ARTIFACT.sha256
    || !Array.isArray(snapshot.files)
    || JSON.stringify(snapshot.files.map(({ path }) => path))
      !== JSON.stringify(upstream.artifact.files)
  ) {
    fail(`${SNAPSHOT_MANIFEST} does not match the pinned package provenance`);
  }
}

export async function verifySnapshot(root = VENDOR_DIRECTORY) {
  const snapshotRoot = resolve(root);
  const upstreamBytes = await readFile(join(snapshotRoot, UPSTREAM_MANIFEST));
  const manifest = parseJson(upstreamBytes, UPSTREAM_MANIFEST);
  validateManifest(manifest, upstreamBytes);

  const packageManifest = parseJson(
    await readFile(join(snapshotRoot, 'package.json')),
    'Vendored package.json',
  );
  validatePackageManifest(packageManifest);

  const snapshotBytes = await readFile(join(snapshotRoot, SNAPSHOT_MANIFEST));
  const snapshot = parseJson(snapshotBytes, SNAPSHOT_MANIFEST);
  validateSnapshotManifest(snapshot, manifest);
  const canonicalSnapshot = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  if (!canonicalSnapshot.equals(snapshotBytes)) {
    fail(`${SNAPSHOT_MANIFEST} is not canonically encoded`);
  }

  const expectedFiles = [
    ...manifest.artifact.files,
    SNAPSHOT_MANIFEST,
    UPSTREAM_MANIFEST,
  ].sort();
  const actualFiles = await listFiles(snapshotRoot);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail('Vendored files do not exactly match the pinned package file allowlist');
  }

  for (const file of snapshot.files) {
    assertExactKeys(file, ['path', 'sha256'], 'snapshot file provenance');
    assertSafePath(file.path);
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) {
      fail(`Invalid snapshot SHA-256 for ${file.path}`);
    }
    const actualHash = hash(
      await readFile(join(snapshotRoot, ...file.path.split('/'))),
      'sha256',
    );
    if (actualHash !== file.sha256) {
      fail(`SHA-256 mismatch for ${file.path}`);
    }
  }
  return manifest;
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || !value) fail(`Invalid argument: ${key ?? ''}`);
    if (options[key] !== undefined) fail(`Duplicate argument: ${key}`);
    options[key] = value;
  }
  const allowed = command === 'sync'
    ? new Set(['--commit', '--repository'])
    : new Set();
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) fail(`Unknown argument: ${unknown}`);
  return { command, options };
}

async function syncSnapshot(options) {
  const requestedCommit = options['--commit'];
  if (!requestedCommit) {
    fail(`Usage: vendor:icon-picker:sync -- --commit ${SOURCE_COMMIT}`);
  }
  if (requestedCommit !== SOURCE_COMMIT) {
    fail(
      `Requested commit ${requestedCommit} does not match repository pin ${SOURCE_COMMIT}; `
      + 'update and review the pin before synchronizing a different commit.',
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mc-icon-picker-sync-'));
  const repository = join(temporaryRoot, 'repository');
  const artifacts = join(temporaryRoot, 'artifacts');
  const extracted = join(temporaryRoot, 'extracted');
  const stagedSnapshot = join(temporaryRoot, 'snapshot');
  const backup = join(ROOT, `.icon-picker-vendor-${process.pid}.backup`);
  try {
    run('git', [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      options['--repository'] ?? SOURCE_REPOSITORY,
      repository,
    ]);
    run('git', ['-C', repository, 'fetch', 'origin', requestedCommit, '--depth=1'], {
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
    run('git', ['-C', repository, 'checkout', '--detach', requestedCommit], {
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
    const actualCommit = run(
      'git',
      ['-C', repository, 'rev-parse', 'HEAD'],
      { env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } },
    ).trim();
    if (actualCommit !== requestedCommit) fail(`Checked out unexpected commit ${actualCommit}`);

    const registry = runNpm(['config', 'get', 'registry'], { cwd: repository }).trim();
    if (registry !== APPROVED_REGISTRY) {
      fail(`Upstream build registry must be ${APPROVED_REGISTRY}; received ${registry}`);
    }
    const buildEnvironment = {
      ...process.env,
      NPM_CONFIG_REGISTRY: APPROVED_REGISTRY,
      SOURCE_COMMIT: requestedCommit,
    };
    runPinnedNpm(
      [
        'ci',
        '--prefer-offline',
        '--no-audit',
        '--no-fund',
        '--fetch-retries=0',
        '--fetch-timeout=15000',
      ],
      { cwd: repository, env: buildEnvironment },
    );
    await mkdir(artifacts);
    runPinnedNpm(['run', 'package:artifact', '--', artifacts], {
      cwd: repository,
      env: buildEnvironment,
    });

    const artifactPath = join(artifacts, ARTIFACT.filename);
    const artifactBytes = await readFile(artifactPath);
    if (
      artifactBytes.length !== ARTIFACT.size
      || hash(artifactBytes, 'sha256') !== ARTIFACT.sha256
      || hash(artifactBytes, 'sha512') !== ARTIFACT.sha512
    ) {
      fail('Built upstream artifact does not match the pinned integrity values');
    }

    const upstreamBytes = await readFile(join(artifacts, UPSTREAM_MANIFEST));
    validateManifest(parseJson(upstreamBytes, UPSTREAM_MANIFEST), upstreamBytes);
    const tarEntries = run('tar', ['-tzf', artifactPath])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((path) => path.replace(/^package\//, ''))
      .sort();
    const upstream = parseJson(upstreamBytes, UPSTREAM_MANIFEST);
    if (JSON.stringify(tarEntries) !== JSON.stringify(upstream.artifact.files)) {
      fail('Artifact archive entries do not match the upstream package allowlist');
    }

    await mkdir(extracted);
    run('tar', ['-xzf', artifactPath, '-C', extracted]);
    await cp(join(extracted, 'package'), stagedSnapshot, { recursive: true });
    await writeFile(join(stagedSnapshot, UPSTREAM_MANIFEST), upstreamBytes);
    const snapshot = await createSnapshotManifest(stagedSnapshot, upstream);
    await writeFile(
      join(stagedSnapshot, SNAPSHOT_MANIFEST),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    await verifySnapshot(stagedSnapshot);

    await mkdir(dirname(VENDOR_DIRECTORY), { recursive: true });
    await rm(backup, { recursive: true, force: true });
    let hadExisting = false;
    try {
      await rename(VENDOR_DIRECTORY, backup);
      hadExisting = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await rename(stagedSnapshot, VENDOR_DIRECTORY);
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (hadExisting) await rename(backup, VENDOR_DIRECTORY);
      throw error;
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
}

async function main(arguments_) {
  const { command, options } = parseArguments(arguments_);
  if (command === 'verify') {
    const manifest = await verifySnapshot();
    process.stdout.write(
      `Verified ${manifest.artifact.entryCount} @rsocko/icon-picker files from `
      + `${manifest.source.commit}\n`,
    );
    return;
  }
  if (command === 'sync') {
    await syncSnapshot(options);
    const manifest = await verifySnapshot();
    process.stdout.write(
      `Synchronized ${manifest.artifact.entryCount} @rsocko/icon-picker files from `
      + `${manifest.source.commit}\n`,
    );
    return;
  }
  fail('Expected command: sync or verify');
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (executedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export {
  APPROVED_REGISTRY,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SOURCE_COMMIT,
};
