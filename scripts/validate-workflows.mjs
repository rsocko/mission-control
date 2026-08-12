import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

const workflowsDirectory = path.resolve('.github', 'workflows');
const workflowFiles = (await readdir(workflowsDirectory))
  .filter((file) => /\.ya?ml$/u.test(file))
  .sort();

assert.ok(workflowFiles.length > 0, 'At least one workflow is required');

const hostedRunners = new Set(['ubuntu-24.04', 'ubuntu-22.04']);
const permissionValues = new Set(['read', 'write', 'none']);
const allowedActions = new Set([
  'actions/attest-build-provenance',
  'actions/checkout',
  'actions/setup-node',
]);
let hasPullRequestWorkflow = false;

function validatePermissions(permissions, location) {
  assert.ok(
    permissions && typeof permissions === 'object' && !Array.isArray(permissions),
    `${location} must declare an explicit permissions map`,
  );

  for (const [permission, value] of Object.entries(permissions)) {
    assert.ok(permission !== 'actions' || value !== 'write', `${location} must not grant actions: write`);
    assert.ok(permissionValues.has(value), `${location}.${permission} has invalid value ${String(value)}`);
  }
}

function collectUses(value, results = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectUses(entry, results);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'uses') results.push(entry);
      collectUses(entry, results);
    }
  }
  return results;
}

for (const file of workflowFiles) {
  const filePath = path.join(workflowsDirectory, file);
  const source = await readFile(filePath, 'utf8');
  const workflow = parse(source);

  assert.ok(workflow && typeof workflow === 'object', `${file} must contain a YAML mapping`);
  assert.ok(workflow.on && typeof workflow.on === 'object', `${file} must declare event triggers`);
  assert.ok(!('pull_request_target' in workflow.on), `${file} must not use pull_request_target`);
  assert.ok(!('workflow_call' in workflow.on), `${file} must not be reusable by another workflow`);
  assert.doesNotMatch(
    source,
    /\$\{\{(?:(?!\}\})[\s\S])*\bsecrets\b/iu,
    `${file} must not reference protected secrets`,
  );
  validatePermissions(workflow.permissions, file);

  const handlesPullRequests = 'pull_request' in workflow.on;
  hasPullRequestWorkflow ||= handlesPullRequests;

  if (handlesPullRequests) {
    for (const [permission, value] of Object.entries(workflow.permissions)) {
      assert.notEqual(value, 'write', `${file} must not grant ${permission}: write on pull requests`);
    }
  }

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const location = `${file}:jobs.${jobName}`;
    assert.ok(!('uses' in job), `${location} must not call a reusable workflow`);
    assert.equal(typeof job['runs-on'], 'string', `${location}.runs-on must be a literal string`);
    assert.ok(
      hostedRunners.has(job['runs-on']),
      `${location}.runs-on must be an approved GitHub-hosted runner`,
    );
    validatePermissions(job.permissions, location);

    if (handlesPullRequests) {
      for (const [permission, value] of Object.entries(job.permissions)) {
        assert.notEqual(value, 'write', `${location} must not grant ${permission}: write on pull requests`);
      }
    }
  }

  for (const uses of collectUses(workflow)) {
    assert.equal(typeof uses, 'string', `${file} contains a non-string uses value`);
    assert.match(
      uses,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u,
      `${file} action references must use a full commit SHA`,
    );
    const action = uses.slice(0, uses.indexOf('@'));
    assert.ok(allowedActions.has(action), `${file} uses action ${action}, which is not allowlisted`);
  }
}

assert.ok(hasPullRequestWorkflow, 'At least one workflow must validate pull requests');
console.log(`Validated ${workflowFiles.length} workflow files`);
