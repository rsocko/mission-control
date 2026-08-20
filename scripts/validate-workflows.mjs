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
  'actions/cache/restore',
  'actions/cache/save',
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

  if (file === 'ci.yml') {
    const changes = workflow.jobs?.changes;
    const shards = workflow.jobs?.['unit-test-shards'];
    const aggregate = workflow.jobs?.['unit-tests'];
    const validate = workflow.jobs?.validate;
    const expensiveStepCondition = "needs.changes.outputs.docs_only != 'true'";
    assert.ok(changes && validate && shards && aggregate, 'ci.yml must classify changes and expose every check');
    assert.equal(changes.name, 'Classify changes', 'change classification must retain its stable name');
    assert.deepEqual(
      changes.outputs,
      { docs_only: '${{ steps.classify.outputs.docs_only }}' },
      'change classification must expose its fail-closed result',
    );
    const classifier = changes.steps?.find((step) => step.id === 'classify');
    assert.ok(classifier, 'ci.yml must classify changed files');
    for (const invariant of [
      'github.event.pull_request.base.sha || github.event.before',
      'github.event.pull_request.head.sha || github.sha',
      '0000000000000000000000000000000000000000',
      'git cat-file -e "${BASE_SHA}^{commit}"',
      'git diff --name-only --diff-filter=ACDMRTUXB -z "${BASE_SHA}" "${HEAD_SHA}"',
      'docs/*|README.md|CODE_OF_CONDUCT.md|CONTRIBUTING.md|DESIGN.md|PRODUCT.md|SECURITY.md|SUPPORT.md',
      'if [[ "${found_change}" != "true" ]]',
    ]) {
      assert.ok(source.includes(invariant), `documentation-only classification must enforce ${invariant}`);
    }
    assert.deepEqual(validate.needs, ['changes'], 'validation jobs must depend on change classification');
    assert.deepEqual(shards.needs, ['changes'], 'unit-test shards must depend on change classification');
    assert.equal(validate.if, 'always()', 'validation jobs must fail closed if change classification fails');
    assert.equal(shards.if, 'always()', 'unit-test shards must fail closed if change classification fails');
    for (const [jobName, job] of Object.entries({ validate, 'unit-test-shards': shards })) {
      const expensiveSteps = job.steps?.filter((step) =>
        step.uses || step.run === 'npm ci --no-audit --no-fund' ||
        step.run?.startsWith('npm test -- --shard=') ||
        step.name?.startsWith('Run ')
      ) ?? [];
      for (const step of expensiveSteps) {
        assert.ok(
          step.if?.includes(expensiveStepCondition),
          `${jobName} step "${step.name}" must be gated for documentation-only changes`,
        );
      }
    }
    assert.deepEqual(
      shards.strategy?.matrix?.shard,
      [1, 2, 3, 4],
      'ci.yml must run four unit-test shards',
    );
    assert.equal(shards.strategy?.['fail-fast'], false, 'unit-test shards must all report their result');
    assert.ok(
      shards.steps?.some((step) =>
        step.run === 'npm test -- --shard=${{ matrix.shard }}/4'
      ),
      'unit-test shards must partition the Vitest suite',
    );
    assert.equal(aggregate.name, 'Unit tests', 'aggregate check must retain its stable name');
    assert.deepEqual(
      aggregate.needs,
      ['unit-test-shards'],
      'aggregate unit-test check must depend on every shard',
    );
    assert.equal(aggregate.if, 'always()', 'aggregate unit-test check must report shard failures');
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (jobName === 'changes' || jobName === 'unit-tests') continue;
      const cacheRestores =
        job.steps?.filter((step) => step.uses?.startsWith('actions/cache/restore@')) ?? [];
      assert.equal(cacheRestores.length, 1, `${jobName} must restore the shared npm cache`);
      assert.equal(
        cacheRestores[0].with?.path,
        '~/.npm',
        `${jobName} must cache npm downloads rather than node_modules`,
      );
    }
    const cacheSaves =
      workflow.jobs?.validate?.steps?.filter((step) =>
        step.uses?.startsWith('actions/cache/save@')
      ) ?? [];
    assert.equal(cacheSaves.length, 1, 'ci.yml must use one designated npm cache writer');
    for (const invariant of [
      "github.ref == 'refs/heads/main'",
      "matrix.name == 'Workflow policy'",
      "steps.npm-cache.outputs.cache-hit != 'true'",
      expensiveStepCondition,
    ]) {
      assert.ok(
        cacheSaves[0].if.includes(invariant),
        `npm cache saves must enforce ${invariant}`,
      );
    }
    assert.equal(
      workflow.jobs?.['unit-test-shards']?.steps?.some((step) =>
        step.uses?.startsWith('actions/cache/save@')
      ),
      false,
      'unit-test shards must not race to save the npm cache',
    );
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
    assert.deepEqual(
      workflow.on.workflow_dispatch?.inputs?.version_mode,
      {
        description: 'How to determine the immutable image tag',
        required: true,
        type: 'choice',
        default: 'next_patch',
        options: ['explicit', 'next_major', 'next_minor', 'next_patch'],
      },
      `${file} manual publication must support established semantic version modes`,
    );
    assert.deepEqual(
      workflow.on.workflow_dispatch?.inputs?.image_tag,
      {
        description: 'Explicit image tag when version_mode=explicit',
        required: false,
        default: '',
        type: 'string',
      },
      `${file} manual publication must accept an explicit immutable tag`,
    );
    assert.deepEqual(
      workflow.on.workflow_dispatch?.inputs?.push_latest,
      {
        description: 'Also promote the image to latest',
        required: true,
        type: 'choice',
        default: 'true',
        options: ['false', 'true'],
      },
      `${file} manual publication must make latest promotion explicit`,
    );
    assert.deepEqual(
      workflow.concurrency,
      {
        group: 'publish-container',
        'cancel-in-progress': false,
      },
      `${file} must serialize every automatic and manual publication`,
    );

    const prepare = workflow.jobs?.prepare;
    const publish = workflow.jobs?.publish;
    assert.ok(prepare && publish, `${file} must separate source verification from publication`);
    assert.deepEqual(prepare.permissions, { contents: 'read' }, `${file} prepare job must be read-only`);
    assert.deepEqual(
      publish.permissions,
      {
        attestations: 'write',
        contents: 'read',
        'id-token': 'write',
        packages: 'write',
      },
      `${file} publish job must use only its required permissions`,
    );
    assert.deepEqual(publish.needs, ['prepare'], `${file} publish job must depend on source verification`);
    assert.equal(
      publish.env?.SOURCE_SHA,
      '${{ needs.prepare.outputs.source_sha }}',
      `${file} publish job must consume the verified source SHA`,
    );
    for (const [jobName, job] of Object.entries({ prepare, publish })) {
      const checkouts = job.steps?.filter((step) => step.uses?.startsWith('actions/checkout@')) ?? [];
      assert.equal(checkouts.length, 1, `${file} ${jobName} job must have exactly one checkout`);
      const [checkout] = checkouts;
      assert.equal(checkout.with?.ref, 'main', `${file} ${jobName} checkout must select main`);
      assert.equal(checkout.with?.['fetch-depth'], 0, `${file} ${jobName} checkout must include main history`);
      assert.equal(
        checkout.with?.['persist-credentials'],
        false,
        `${file} ${jobName} checkout must not persist credentials`,
      );
    }

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
      'trusted_main_sha="$(git rev-parse HEAD)"',
      'git merge-base --is-ancestor "${source_sha}" "${trusted_main_sha}"',
      'git merge-base --is-ancestor "${SOURCE_SHA}" "${trusted_main_sha}"',
      'git checkout --detach "${SOURCE_SHA}"',
      'actual_sha="$(git rev-parse HEAD)"',
      'export VERSION_MODE="next_patch"',
      'sha_tag="sha-${SOURCE_SHA:0:7}"',
      'python3 .github/scripts/resolve_registry_version.py',
      'require_absent "${IMAGE}:${VERSION_TAG}"',
      'require_absent "${IMAGE}:${SHA_TAG}"',
      'docker buildx imagetools create',
      'verification_refs+=("${sha_ref}")',
      'verification_refs+=("${latest_ref}")',
      "--format '{{.Manifest.Digest}}'",
      'verify_digest "${reference}"',
    ]) {
      assert.ok(source.includes(invariant), `${file} must enforce publication invariant: ${invariant}`);
    }
    assert.doesNotMatch(
      source,
      /(?:cache-from|cache-to):?\s+type=gha/u,
      `${file} must not enable the BuildKit cache unless benchmarks meet the documented threshold`,
    );
    const attestationSteps =
      publish.steps?.filter((step) => step.uses?.startsWith('actions/attest@')) ?? [];
    assert.equal(attestationSteps.length, 1, `${file} publish job must have exactly one attestation`);
    assert.equal(
      attestationSteps[0].uses,
      'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d',
      `${file} attestation must pin a default-provenance-capable actions/attest release`,
    );
    assert.deepEqual(
      attestationSteps[0].with,
      {
        'subject-name': '${{ steps.image.outputs.name }}',
        'subject-digest': '${{ steps.publish.outputs.digest }}',
        'push-to-registry': true,
      },
      `${file} attestation must use supported default provenance for the published digest`,
    );
    const loginIndex = publish.steps.findIndex((step) => step.name === 'Log in to GHCR');
    const resolveIndex = publish.steps.findIndex((step) => step.name === 'Resolve immutable publication tags');
    const buildIndex = publish.steps.findIndex((step) => step.name === 'Build and publish digest-oriented image');
    const attestIndex = publish.steps.findIndex((step) => step.name === 'Attest build provenance');
    const promoteIndex = publish.steps.findIndex((step) => step.name === 'Promote attested digest to requested tags');
    assert.ok(loginIndex >= 0 && resolveIndex > loginIndex, `${file} must resolve versions after GHCR login`);
    assert.ok(buildIndex > resolveIndex, `${file} must resolve and reserve immutable tags before building`);
    assert.ok(attestIndex > buildIndex, `${file} must attest the digest after building`);
    assert.ok(promoteIndex > attestIndex, `${file} must promote only the attested digest`);
    assert.doesNotMatch(
      source,
      /\bgit\s+fetch\b/u,
      `${file} must not fetch after checkout removes private-repository credentials`,
    );
    assert.ok(!source.includes('GITHUB_SHA'), `${file} must not build or attest the trigger-context SHA`);
  }

  for (const uses of collectUses(workflow)) {
    assert.equal(typeof uses, 'string', `${file} contains a non-string uses value`);
    assert.match(
      uses,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u,
      `${file} action references must use a full commit SHA`,
    );
    const action = uses.slice(0, uses.indexOf('@'));
    assert.ok(allowedActions.has(action), `${file} uses action ${action}, which is not allowlisted`);
  }
}

assert.ok(hasPullRequestWorkflow, 'At least one workflow must validate pull requests');
console.log(`Validated ${workflowFiles.length} workflow files`);
