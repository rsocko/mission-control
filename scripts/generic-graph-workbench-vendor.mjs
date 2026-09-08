import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIRECTORY = join(ROOT, 'vendor', 'generic-graph-workbench');
const MANIFEST_NAME = 'generic-graph-workbench.snapshot.json';
const SOURCE_REPOSITORY = 'https://github.com/rsocko/ideation';
const SOURCE_COMMIT = 'ed50b3b0313470540a58e1447e009c1620fe7f21';
const PACKAGE_NAME = '@rsocko/generic-graph-canvas-shared-workbench';
const PACKAGE_VERSION = '0.0.0';
const PACKAGE_PATH = 'experiments/computing/generic-graph-canvas/packages/shared-workbench';
const GENERATOR_PATH = `${PACKAGE_PATH}/scripts/source-snapshot.mjs`;
const GENERATOR_BLOB = 'f7b92daca6ae90367bd7607bb2e476de5b0cb89c';
const GENERATOR = Object.freeze({
  name: 'generic-graph-workbench-source-snapshot',
  version: 1,
});
const PINNED_MANIFEST_SHA256 = '5c3c350b334a9799fd9d5ec6cdf9040129f4766d3ada2e0116ce9dc4d1127227';
const PUBLIC_EXPORTS = Object.freeze([
  { subpath: './controllers', path: 'src/controllers/index.ts' },
  { subpath: './core', path: 'src/core/index.ts' },
  { subpath: './host', path: 'src/host/index.ts' },
  { subpath: './layout', path: 'src/layout/index.ts' },
  { subpath: './react', path: 'src/react/index.ts' },
]);

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

function runGit(repository, arguments_, encoding = 'utf8') {
  return run('git', ['-C', repository, ...arguments_], {
    encoding,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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
    || path.split('/').includes('.')
    || path.split('/').includes('..')
  ) {
    fail(`Snapshot path escapes the vendor root: ${String(path)}`);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  if (current !== root && entries.length === 0) {
    fail(`Snapshot contains an empty directory: ${relative(root, current)}`);
  }
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    const snapshotPath = relative(root, absolutePath).split(sep).join('/');
    if (entry.isSymbolicLink()) {
      fail(`Snapshot contains a symbolic link: ${snapshotPath}`);
    }
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

function dependencyCandidates(importer, specifier) {
  const importerDirectory = dirname(importer);
  const unresolved = join(importerDirectory, specifier).split(sep).join('/');
  assertSafePath(unresolved);
  const extension = extname(unresolved);
  if (extension === '.js') {
    return [
      `${unresolved.slice(0, -3)}.ts`,
      `${unresolved.slice(0, -3)}.tsx`,
      unresolved,
    ];
  }
  if (extension) return [unresolved];
  return [
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    `${unresolved}/index.ts`,
    `${unresolved}/index.tsx`,
  ];
}

async function isFile(root, path) {
  try {
    return (await lstat(join(root, ...path.split('/')))).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function sourceClosure(root) {
  const pending = PUBLIC_EXPORTS.map(({ path }) => path);
  const files = new Set();
  while (pending.length > 0) {
    const path = pending.shift();
    if (!path || files.has(path)) continue;
    assertSafePath(path);
    let bytes;
    try {
      bytes = await readFile(join(root, ...path.split('/')));
    } catch (error) {
      if (error?.code === 'ENOENT') fail(`Snapshot is missing ${path}`);
      throw error;
    }
    files.add(path);
    if (!['.ts', '.tsx'].includes(extname(path))) continue;
    const imports = [
      ...new Set(
        ts.preProcessFile(bytes.toString('utf8'), true, true).importedFiles
          .map(({ fileName }) => fileName)
          .filter((specifier) => specifier.startsWith('.')),
      ),
    ].sort();
    for (const specifier of imports) {
      const candidates = dependencyCandidates(path, specifier);
      let dependency;
      for (const candidate of candidates) {
        if (await isFile(root, candidate)) {
          dependency = candidate;
          break;
        }
      }
      if (!dependency) fail(`Unable to resolve ${specifier} imported by ${path}`);
      if (!files.has(dependency)) pending.push(dependency);
    }
  }
  return [...files].sort();
}

export async function verifySnapshot(root = VENDOR_DIRECTORY) {
  const snapshotRoot = resolve(root);
  const manifestBytes = await readFile(join(snapshotRoot, MANIFEST_NAME));
  if (sha256(manifestBytes) !== PINNED_MANIFEST_SHA256) {
    fail(`${MANIFEST_NAME} does not match the repository-owned pinned digest`);
  }
  const manifest = parseJson(manifestBytes, MANIFEST_NAME);
  assertExactKeys(
    manifest,
    ['exports', 'files', 'generator', 'package', 'schemaVersion', 'source'],
    MANIFEST_NAME,
  );
  assertExactKeys(manifest.package, ['name', 'version'], 'package provenance');
  assertExactKeys(manifest.source, ['commit', 'repository'], 'source provenance');
  assertExactKeys(manifest.generator, ['name', 'version'], 'generator provenance');
  if (
    manifest.schemaVersion !== 1
    || manifest.package.name !== PACKAGE_NAME
    || manifest.package.version !== PACKAGE_VERSION
    || manifest.source.repository !== SOURCE_REPOSITORY
    || manifest.source.commit !== SOURCE_COMMIT
    || JSON.stringify(manifest.generator) !== JSON.stringify(GENERATOR)
    || JSON.stringify(manifest.exports) !== JSON.stringify(PUBLIC_EXPORTS)
    || !Array.isArray(manifest.files)
  ) {
    fail(`${MANIFEST_NAME} does not match the pinned provider contract`);
  }
  const canonicalManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (!canonicalManifest.equals(manifestBytes)) {
    fail(`${MANIFEST_NAME} is not canonically encoded`);
  }

  const packageBytes = await readFile(join(snapshotRoot, 'package.json'));
  const packageManifest = parseJson(packageBytes, 'Snapshot package.json');
  assertExactKeys(
    packageManifest,
    [
      'dependencies',
      'description',
      'exports',
      'name',
      'peerDependencies',
      'peerDependenciesMeta',
      'private',
      'type',
      'version',
    ],
    'Snapshot package.json',
  );
  assertExactKeys(
    packageManifest.exports,
    PUBLIC_EXPORTS.map(({ subpath }) => subpath),
    'Snapshot package exports',
  );
  if (
    packageManifest.name !== PACKAGE_NAME
    || packageManifest.version !== PACKAGE_VERSION
    || packageManifest.private !== true
    || packageManifest.type !== 'module'
  ) {
    fail('Snapshot package.json identity does not match the pinned package');
  }
  for (const exported of PUBLIC_EXPORTS) {
    if (packageManifest.exports[exported.subpath] !== `./${exported.path}`) {
      fail(`Snapshot package.json does not expose ${exported.subpath}`);
    }
  }

  const declaredFiles = manifest.files.map(({ path, sha256: hash }) => {
    assertExactKeys({ path, sha256: hash }, ['path', 'sha256'], 'file provenance');
    assertSafePath(path);
    if (!/^[0-9a-f]{64}$/.test(hash ?? '')) fail(`Invalid SHA-256 for ${path}`);
    return path;
  });
  if (
    JSON.stringify(declaredFiles) !== JSON.stringify([...declaredFiles].sort())
    || new Set(declaredFiles).size !== declaredFiles.length
  ) {
    fail(`${MANIFEST_NAME} file paths must be unique and sorted`);
  }
  const closure = await sourceClosure(snapshotRoot);
  const requiredFiles = ['package.json', ...closure].sort();
  if (JSON.stringify(declaredFiles) !== JSON.stringify(requiredFiles)) {
    fail('Snapshot manifest does not contain the exact public source closure');
  }
  const actualFiles = (await listFiles(snapshotRoot))
    .filter((path) => path !== MANIFEST_NAME);
  if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
    fail('Snapshot files do not exactly match the provenance manifest');
  }
  for (const declared of manifest.files) {
    const actualHash = sha256(await readFile(join(snapshotRoot, ...declared.path.split('/'))));
    if (actualHash !== declared.sha256) {
      fail(`SHA-256 mismatch for ${declared.path}`);
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
  const allowed = command === 'sync' ? new Set(['--repository']) : new Set();
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) fail(`Unknown argument: ${unknown}`);
  return { command, options };
}

async function syncSnapshot(repositoryInput) {
  if (!repositoryInput) {
    fail('Usage: vendor:sync -- --repository <local-ideation-checkout>');
  }
  const repository = runGit(resolve(repositoryInput), ['rev-parse', '--show-toplevel']).trim();
  const commit = runGit(repository, ['rev-parse', '--verify', `${SOURCE_COMMIT}^{commit}`]).trim();
  if (commit !== SOURCE_COMMIT) fail(`Pinned commit ${SOURCE_COMMIT} is unavailable`);
  const treeEntry = runGit(repository, ['ls-tree', SOURCE_COMMIT, GENERATOR_PATH]).trim().split(/\s+/);
  if (treeEntry[2] !== GENERATOR_BLOB) {
    fail(`Pinned generator blob must be ${GENERATOR_BLOB}`);
  }

  const temporaryScript = join(ROOT, 'scripts', `.generic-graph-source-snapshot-${process.pid}.mjs`);
  const temporaryOutput = join(ROOT, `.${MANIFEST_NAME}.${process.pid}.tmp`);
  const backup = join(ROOT, `.${MANIFEST_NAME}.${process.pid}.backup`);
  await rm(temporaryOutput, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  try {
    const generatorBytes = runGit(
      repository,
      ['cat-file', 'blob', `${SOURCE_COMMIT}:${GENERATOR_PATH}`],
      null,
    );
    await writeFile(temporaryScript, generatorBytes);
    run(process.execPath, [
      temporaryScript,
      'export',
      '--repository',
      repository,
      '--commit',
      SOURCE_COMMIT,
      '--output',
      temporaryOutput,
    ]);
    run(process.execPath, [
      temporaryScript,
      'verify',
      '--input',
      temporaryOutput,
      '--repository',
      repository,
    ]);
    await verifySnapshot(temporaryOutput);

    await mkdir(dirname(VENDOR_DIRECTORY), { recursive: true });
    let hadExisting = false;
    try {
      await rename(VENDOR_DIRECTORY, backup);
      hadExisting = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await rename(temporaryOutput, VENDOR_DIRECTORY);
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (hadExisting) await rename(backup, VENDOR_DIRECTORY);
      throw error;
    }
  } finally {
    await rm(temporaryScript, { force: true });
    await rm(temporaryOutput, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
}

async function main(arguments_) {
  const { command, options } = parseArguments(arguments_);
  if (command === 'verify') {
    const manifest = await verifySnapshot();
    process.stdout.write(
      `Verified ${manifest.files.length} files from ${manifest.source.commit}\n`,
    );
    return;
  }
  if (command === 'sync') {
    await syncSnapshot(options['--repository']);
    const manifest = await verifySnapshot();
    process.stdout.write(
      `Synchronized ${manifest.files.length} files from ${manifest.source.commit}\n`,
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
