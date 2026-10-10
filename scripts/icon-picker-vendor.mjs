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
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIRECTORY = join(ROOT, 'vendor', 'icon-picker');
const UPSTREAM_MANIFEST = 'UPSTREAM.json';
const SNAPSHOT_MANIFEST = 'icon-picker.snapshot.json';
const PIN_PATH = join(ROOT, 'scripts', 'icon-picker-vendor-pin.json');
const SOURCE_REPOSITORY = 'https://github.com/rsocko/icon-picker.git';
const LOCAL_REGISTRY = 'https://packagefeedproxy.microsoft.io/npm/';
const CI_REGISTRY = 'https://registry.npmjs.org/';
const APPROVED_REGISTRY = process.env.GITHUB_ACTIONS === 'true' ? CI_REGISTRY : LOCAL_REGISTRY;
const PACKAGE_NAME = '@rsocko/icon-picker';
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

async function loadPin(path = PIN_PATH) {
  const bytes = await readFile(path);
  const pin = parseJson(bytes, 'Icon picker vendor pin');
  assertExactKeys(
    pin,
    [
      'artifact',
      'npmVersion',
      'packageVersion',
      'schemaVersion',
      'sourceCommit',
      'sourceTag',
    ],
    'Icon picker vendor pin',
  );
  assertExactKeys(
    pin.artifact,
    [
      'entryCount',
      'filename',
      'integrity',
      'sha256',
      'sha512',
      'shasum',
      'size',
      'unpackedSize',
    ],
    'Icon picker vendor artifact pin',
  );
  if (
    pin.schemaVersion !== 1
    || !/^[0-9a-f]{40}$/u.test(pin.sourceCommit)
    || (pin.sourceTag !== null && typeof pin.sourceTag !== 'string')
    || typeof pin.packageVersion !== 'string'
    || !/^npm@\d+\.\d+\.\d+$/u.test(`npm@${pin.npmVersion}`)
  ) {
    fail('Icon picker vendor pin contains invalid identity fields');
  }
  return { pin };
}

const { pin: INITIAL_PIN } = await loadPin();
const PACKAGE_VERSION = INITIAL_PIN.packageVersion;
const SOURCE_COMMIT = INITIAL_PIN.sourceCommit;
const SOURCE_TAG = INITIAL_PIN.sourceTag;

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

function runPinnedNpm(version, arguments_, options = {}) {
  return runNpm(
    [
      'exec',
      '--yes',
      `--package=npm@${version}`,
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

function hashBase64(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest('base64');
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

function validateManifest(manifest, bytes, pin) {
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
    || manifest.package.version !== pin.packageVersion
    || manifest.source.repository !== `git+${SOURCE_REPOSITORY}`
    || manifest.source.commit !== pin.sourceCommit
    || manifest.source.tag !== pin.sourceTag
    || manifest.acquisition !== 'canonical-npm-pack-from-source'
    || manifest.canonicalization.lineEndings !== 'lf'
    || manifest.canonicalization.artifactContract !== 'package-artifact.json'
  ) {
    fail(`${UPSTREAM_MANIFEST} does not match the pinned upstream identity`);
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.package.version)
    || (
      manifest.source.tag !== null
      && manifest.source.tag !== `v${manifest.package.version}`
    )
    || manifest.artifact.filename !== `rsocko-icon-picker-${manifest.package.version}.tgz`
    || !Number.isSafeInteger(manifest.artifact.size)
    || manifest.artifact.size <= 0
    || !Number.isSafeInteger(manifest.artifact.unpackedSize)
    || manifest.artifact.unpackedSize <= 0
    || !Number.isSafeInteger(manifest.artifact.entryCount)
    || manifest.artifact.entryCount <= 0
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(manifest.artifact.integrity)
    || !/^[0-9a-f]{40}$/u.test(manifest.artifact.shasum)
    || !/^[0-9a-f]{64}$/u.test(manifest.artifact.sha256)
    || !/^[0-9a-f]{128}$/u.test(manifest.artifact.sha512)
  ) {
    fail(`${UPSTREAM_MANIFEST} contains invalid package artifact metadata`);
  }
  for (const [key, value] of Object.entries(pin.artifact)) {
    if (manifest.artifact[key] !== value) {
      fail(`${UPSTREAM_MANIFEST} artifact ${key} does not match the pinned value`);
    }
  }
  if (
    !Array.isArray(manifest.artifact.files)
    || manifest.artifact.files.length !== pin.artifact.entryCount
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

function validatePackageManifest(packageManifest, pin) {
  if (
    packageManifest.name !== PACKAGE_NAME
    || packageManifest.version !== pin.packageVersion
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

function validateSnapshotManifest(snapshot, upstream, pin) {
  assertExactKeys(
    snapshot,
    ['artifactSha256', 'files', 'package', 'schemaVersion', 'source'],
    SNAPSHOT_MANIFEST,
  );
  if (
    snapshot.schemaVersion !== 1
    || JSON.stringify(snapshot.package) !== JSON.stringify(upstream.package)
    || JSON.stringify(snapshot.source) !== JSON.stringify(upstream.source)
    || snapshot.artifactSha256 !== pin.artifact.sha256
    || !Array.isArray(snapshot.files)
    || JSON.stringify(snapshot.files.map(({ path }) => path))
      !== JSON.stringify(upstream.artifact.files)
  ) {
    fail(`${SNAPSHOT_MANIFEST} does not match the pinned package provenance`);
  }
}

export async function verifySnapshot(root = VENDOR_DIRECTORY, pinOverride) {
  const snapshotRoot = resolve(root);
  const { pin } = pinOverride ? { pin: pinOverride } : await loadPin();
  const upstreamBytes = await readFile(join(snapshotRoot, UPSTREAM_MANIFEST));
  const manifest = parseJson(upstreamBytes, UPSTREAM_MANIFEST);
  validateManifest(manifest, upstreamBytes, pin);

  const packageManifest = parseJson(
    await readFile(join(snapshotRoot, 'package.json')),
    'Vendored package.json',
  );
  validatePackageManifest(packageManifest, pin);

  const snapshotBytes = await readFile(join(snapshotRoot, SNAPSHOT_MANIFEST));
  const snapshot = parseJson(snapshotBytes, SNAPSHOT_MANIFEST);
  validateSnapshotManifest(snapshot, manifest, pin);
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
    ? new Set(['--commit', '--repository', '--update-pin'])
    : new Set();
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) fail(`Unknown argument: ${unknown}`);
  return { command, options };
}

async function totalArtifactSize(root, files) {
  let total = 0;
  for (const path of files) {
    total += (await stat(join(root, ...path.split('/')))).size;
  }
  return total;
}

function createCandidatePin(manifest, npmVersion) {
  const artifact = Object.fromEntries(
    Object.entries(manifest.artifact).filter(([key]) => key !== 'files'),
  );
  return {
    schemaVersion: 1,
    sourceCommit: manifest.source.commit,
    sourceTag: manifest.source.tag,
    packageVersion: manifest.package.version,
    npmVersion,
    artifact,
  };
}

async function replaceSnapshotAndPin(stagedSnapshot, pin) {
  const vendorBackup = join(ROOT, `.icon-picker-vendor-${process.pid}.backup`);
  const pinBackup = `${PIN_PATH}.${process.pid}.backup`;
  const stagedPin = `${PIN_PATH}.${process.pid}.tmp`;
  let vendorBackedUp = false;
  let pinBackedUp = false;
  await writeFile(stagedPin, `${JSON.stringify(pin, null, 2)}\n`);
  await rm(vendorBackup, { recursive: true, force: true });
  await rm(pinBackup, { force: true });
  try {
    try {
      await rename(VENDOR_DIRECTORY, vendorBackup);
      vendorBackedUp = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(PIN_PATH, pinBackup);
    pinBackedUp = true;
    await rename(stagedSnapshot, VENDOR_DIRECTORY);
    await rename(stagedPin, PIN_PATH);
    await verifySnapshot();
    await rm(vendorBackup, { recursive: true, force: true });
    await rm(pinBackup, { force: true });
  } catch (error) {
    const rollbackErrors = [];
    await rm(VENDOR_DIRECTORY, { recursive: true, force: true });
    await rm(PIN_PATH, { force: true });
    if (vendorBackedUp) {
      try {
        await rename(vendorBackup, VENDOR_DIRECTORY);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (pinBackedUp) {
      try {
        await rename(pinBackup, PIN_PATH);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'Failed to restore vendor snapshot');
    }
    throw error;
  } finally {
    await rm(stagedPin, { force: true });
  }
}

async function syncSnapshot(options) {
  const { pin: committedPin } = await loadPin();
  const requestedCommit = options['--commit'];
  if (!requestedCommit) {
    fail(`Usage: vendor:icon-picker:sync -- --commit ${committedPin.sourceCommit}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(requestedCommit)) {
    fail('Requested commit must be a full lowercase SHA');
  }
  const updatePin = options['--update-pin'] === 'true';
  if (options['--update-pin'] !== undefined && !['true', 'false'].includes(options['--update-pin'])) {
    fail('--update-pin must be true or false');
  }
  if (requestedCommit !== committedPin.sourceCommit && !updatePin) {
    fail(
      `Requested commit ${requestedCommit} does not match repository pin `
      + `${committedPin.sourceCommit}; pass --update-pin true only when generating a reviewable update.`,
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mc-icon-picker-sync-'));
  const repository = join(temporaryRoot, 'repository');
  const artifacts = join(temporaryRoot, 'artifacts');
  const extracted = join(temporaryRoot, 'extracted');
  const stagedSnapshot = join(temporaryRoot, 'snapshot');
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

    const upstreamPackage = parseJson(
      await readFile(join(repository, 'package.json')),
      'Upstream package.json',
    );
    const packageManager = /^npm@(\d+\.\d+\.\d+)$/u.exec(upstreamPackage.packageManager ?? '');
    if (
      upstreamPackage.name !== PACKAGE_NAME
      || upstreamPackage.private === true
      || upstreamPackage.type !== 'module'
      || typeof upstreamPackage.version !== 'string'
      || !packageManager
      || JSON.stringify(upstreamPackage.exports) !== JSON.stringify(PACKAGE_EXPORTS)
    ) {
      fail('Upstream package does not match the required package identity and exports');
    }
    const npmVersion = packageManager[1];
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
      npmVersion,
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
    runPinnedNpm(npmVersion, ['run', 'package:artifact', '--', artifacts], {
      cwd: repository,
      env: buildEnvironment,
    });

    const upstreamBytes = await readFile(join(artifacts, UPSTREAM_MANIFEST));
    const upstream = parseJson(upstreamBytes, UPSTREAM_MANIFEST);
    const candidatePin = createCandidatePin(upstream, npmVersion);
    validateManifest(upstream, upstreamBytes, candidatePin);
    const artifactPath = join(artifacts, candidatePin.artifact.filename);
    const artifactBytes = await readFile(artifactPath);
    if (
      artifactBytes.length !== candidatePin.artifact.size
      || hash(artifactBytes, 'sha1') !== candidatePin.artifact.shasum
      || hash(artifactBytes, 'sha256') !== candidatePin.artifact.sha256
      || hash(artifactBytes, 'sha512') !== candidatePin.artifact.sha512
      || `sha512-${hashBase64(artifactBytes, 'sha512')}` !== candidatePin.artifact.integrity
    ) {
      fail('Built upstream artifact does not match its canonical integrity values');
    }

    const tarEntries = run('tar', ['-tzf', artifactPath])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((path) => path.replace(/^package\//, ''))
      .sort();
    if (JSON.stringify(tarEntries) !== JSON.stringify(upstream.artifact.files)) {
      fail('Artifact archive entries do not match the upstream package allowlist');
    }

    await mkdir(extracted);
    run('tar', ['-xzf', artifactPath, '-C', extracted]);
    if (
      await totalArtifactSize(join(extracted, 'package'), upstream.artifact.files)
      !== candidatePin.artifact.unpackedSize
    ) {
      fail('Artifact unpacked size does not match its canonical metadata');
    }
    await cp(join(extracted, 'package'), stagedSnapshot, { recursive: true });
    await writeFile(join(stagedSnapshot, UPSTREAM_MANIFEST), upstreamBytes);
    const snapshot = await createSnapshotManifest(stagedSnapshot, upstream);
    await writeFile(
      join(stagedSnapshot, SNAPSHOT_MANIFEST),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    await verifySnapshot(stagedSnapshot, candidatePin);
    if (!updatePin && JSON.stringify(candidatePin) !== JSON.stringify(committedPin)) {
      fail('Rebuilt artifact no longer matches the committed pin');
    }

    await mkdir(dirname(VENDOR_DIRECTORY), { recursive: true });
    await replaceSnapshotAndPin(stagedSnapshot, candidatePin);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
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
  SOURCE_TAG,
  CI_REGISTRY,
  LOCAL_REGISTRY,
};
