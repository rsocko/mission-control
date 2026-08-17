import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const hookManifestPath = path.join(root, '.github', 'hooks', 'impeccable.json');
const liveConfigPath = path.join(root, '.impeccable', 'live', 'config.json');
const skillPath = path.join(root, '.github', 'skills', 'impeccable', 'SKILL.md');
const expectedPayload = {
  fileCount: 152,
  sha256: '25c8cff9020ce3abfa84f7fc3f9d5de74ba157dd83fb8778d79d1aa7ae76bea9',
};

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function collectStrings(value, results = []) {
  if (typeof value === 'string') {
    results.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, results);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStrings(entry, results);
  }
  return results;
}

const hookManifest = await readJson(hookManifestPath);
const postToolUseHooks = hookManifest.hooks?.postToolUse;
assert.ok(Array.isArray(postToolUseHooks) && postToolUseHooks.length > 0, 'Impeccable postToolUse hook is required');
for (const hook of postToolUseHooks) {
  assert.equal(typeof hook.bash, 'string', 'Impeccable hook needs a bash command for cloud and POSIX agents');
  assert.equal(typeof hook.powershell, 'string', 'Impeccable hook needs a PowerShell command for Windows CLI');
  assert.match(hook.powershell, /\[Console\]::In\.ReadToEnd\(\)/u, 'PowerShell hook must preserve stdin across its version check');
}

const scriptReferences = collectStrings(hookManifest)
  .flatMap((value) => value.match(/\.github\/skills\/impeccable\/scripts\/[\w./-]+\.mjs/gu) ?? []);

assert.ok(scriptReferences.length > 0, 'Impeccable hook must reference at least one skill script');
for (const reference of new Set(scriptReferences)) {
  await access(path.join(root, ...reference.split('/')));
}

const liveConfig = await readJson(liveConfigPath);
assert.equal(liveConfig.cspChecked, true, 'Impeccable live config must record a completed CSP review');
assert.ok(Array.isArray(liveConfig.files) && liveConfig.files.length > 0, 'Impeccable live config needs an injection target');

const anchorKey = liveConfig.insertBefore ? 'insertBefore' : 'insertAfter';
const anchor = liveConfig[anchorKey];
assert.equal(typeof anchor, 'string', 'Impeccable live config needs insertBefore or insertAfter');

for (const target of liveConfig.files) {
  assert.doesNotMatch(target, /[*?]/u, `Validation requires a literal live target, received ${target}`);
  const source = await readFile(path.join(root, ...target.split('/')), 'utf8');
  assert.ok(source.includes(anchor), `${target} does not contain the configured live injection anchor ${anchor}`);
}

const skill = await readFile(skillPath, 'utf8');
assert.match(skill, /^version: 4\.1\.1$/mu, 'Unexpected Impeccable skill version');
assert.match(skill, /^license: Apache 2\.0$/mu, 'Impeccable skill must declare its upstream license');

const license = await readFile(
  path.join(root, '.github', 'skills', 'impeccable', 'LICENSE'),
  'utf8',
);
assert.match(license, /Apache License\s+Version 2\.0, January 2004/u);
assert.match(license, /Copyright 2025 Paul Bakaus/u);

const notices = await readFile(
  path.join(root, '.github', 'skills', 'impeccable', 'THIRD_PARTY_NOTICES.md'),
  'utf8',
);
assert.match(notices, /modern-screenshot/u);
assert.match(notices, /platform-design-skills/u);

async function collectFiles(entryPath, results) {
  const entryStat = await stat(entryPath);
  if (entryStat.isDirectory()) {
    const entries = await readdir(entryPath);
    for (const entry of entries) {
      await collectFiles(path.join(entryPath, entry), results);
    }
  } else {
    results.push(path.relative(root, entryPath).split(path.sep).join('/'));
  }
}

const payloadFiles = [];
for (const entry of [
  '.github/skills/impeccable/SKILL.md',
  '.github/skills/impeccable/reference',
  '.github/skills/impeccable/scripts',
  '.github/agents',
]) {
  await collectFiles(path.join(root, ...entry.split('/')), payloadFiles);
}
payloadFiles.sort();

const payloadHash = createHash('sha256');
for (const file of payloadFiles) {
  const normalized = (await readFile(path.join(root, ...file.split('/')), 'utf8'))
    .replace(/\r\n/gu, '\n');
  const fileHash = createHash('sha256').update(normalized).digest('hex');
  payloadHash.update(`${file}\0${fileHash}\n`);
}

assert.equal(payloadFiles.length, expectedPayload.fileCount, 'Unexpected Impeccable provider file count');
assert.equal(payloadHash.digest('hex'), expectedPayload.sha256, 'Impeccable provider payload differs from reviewed 4.1.1 build');

console.log('Impeccable hooks, live injection, licenses, and provider payload are valid.');
