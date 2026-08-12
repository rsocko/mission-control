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
  'actions/attest',
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
  const hasWritePermissions = Object.values(workflow.jobs ?? {}).some((job) =>
    Object.values(job.permissions ?? {}).includes('write'),
  );

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

  if (hasWritePermissions) {
    assert.ok(!('push' in workflow.on), `${file} must not publish directly from a push event`);
    assert.ok(!('pull_request' in workflow.on), `${file} must not publish from pull requests`);
    assert.deepEqual(
      workflow.on.workflow_run,
      { workflows: ['CI'], types: ['completed'] },
      `${file} publication must follow completion of the CI workflow`,
    );
    assert.deepEqual(
      workflow.on.workflow_dispatch?.inputs?.commit,
      {
        description: 'Full commit SHA from the main branch history to publish',
        required: true,
        type: 'string',
      },
      `${file} manual publication must require an explicit full commit SHA`,
    );

    const prepare = workflow.jobs?.prepare;
    const publish = workflow.jobs?.publish;
    assert.ok(prepare && publish, `${file} must separate source verification from publication`);
    assert.deepEqual(prepare.permissions, { contents: 'read' }, `${file} prepare job must be read-only`);
    assert.deepEqual(publish.needs, ['prepare'], `${file} publish job must depend on source verification`);
    assert.equal(
      publish.env?.SOURCE_SHA,
      '${{ needs.prepare.outputs.source_sha }}',
      `${file} publish job must consume the verified source SHA`,
    );

    const prepareCondition = prepare.if ?? '';
    for (const invariant of [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      'github.event.workflow_run.head_repository.id == github.event.repository.id',
      "github.ref == 'refs/heads/main'",
    ]) {
      assert.ok(prepareCondition.includes(invariant), `${file} prepare condition must enforce ${invariant}`);
    }

    for (const invariant of [
      '^[0-9a-f]{40}$',
      'git merge-base --is-ancestor "${source_sha}" refs/remotes/origin/main',
      'actual_sha="$(git rev-parse HEAD)"',
      'git merge-base --is-ancestor "${SOURCE_SHA}" refs/remotes/origin/main',
      'provenance-build-type-v1.md',
      'externalParameters: {',
      'builder: {',
      'id: $builder_id',
      'digest: {gitCommit: $source_sha}',
      'predicate-type: https://slsa.dev/provenance/v1',
    ]) {
      assert.ok(source.includes(invariant), `${file} must enforce publication invariant: ${invariant}`);
    }
    assert.ok(!source.includes('GITHUB_SHA'), `${file} must not build or attest the trigger-context SHA`);
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
