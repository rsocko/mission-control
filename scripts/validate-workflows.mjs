import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const execFileAsync = promisify(execFile);
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

function isDocumentationPath(file) {
  return file.startsWith('docs/') ||
    new Set([
      'README.md',
      'CODE_OF_CONDUCT.md',
      'CONTRIBUTING.md',
      'DESIGN.md',
      'PRODUCT.md',
      'SECURITY.md',
      'SUPPORT.md',
    ]).has(file);
}

async function validateRenameClassification() {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'mission-control-workflow-'));
  try {
    await mkdir(path.join(repository, '.github', 'workflows'), { recursive: true });
    await mkdir(path.join(repository, 'docs'), { recursive: true });
    await mkdir(path.join(repository, 'src'), { recursive: true });
    await writeFile(path.join(repository, 'src', 'feature.ts'), 'export const feature = true;\n');
    await writeFile(path.join(repository, '.github', 'workflows', 'example.yml'), 'name: Example\n');
    await writeFile(path.join(repository, 'docs', 'old.md'), '# Old\n');

    const git = (...args) => execFileAsync('git', args, { cwd: repository });
    await git('init', '--quiet');
    await git('config', 'user.email', 'workflow-validator@example.invalid');
    await git('config', 'user.name', 'Workflow validator');
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'Base fixtures');
    const { stdout: baseOutput } = await git('rev-parse', 'HEAD');
    const base = baseOutput.trim();

    await git('mv', 'src/feature.ts', 'docs/feature.ts');
    await git('mv', '.github/workflows/example.yml', 'docs/example.yml');
    await git('mv', 'docs/old.md', 'docs/new.md');
    await git('commit', '--quiet', '-m', 'Rename fixtures');
    const { stdout: headOutput } = await git('rev-parse', 'HEAD');
    const head = headOutput.trim();
    const { stdout } = await git(
      'diff',
      '--no-renames',
      '--name-only',
      '--diff-filter=ACDMRTUXB',
      base,
      head,
    );
    const changedPaths = stdout.trim().split(/\r?\n/u).sort();

    assert.deepEqual(
      changedPaths,
      [
        '.github/workflows/example.yml',
        'docs/example.yml',
        'docs/feature.ts',
        'docs/new.md',
        'docs/old.md',
        'src/feature.ts',
      ],
      'rename-safe classification must inspect both source and destination paths',
    );
    assert.equal(
      ['src/feature.ts', 'docs/feature.ts'].every(isDocumentationPath),
      false,
      'moving code into docs must not be documentation-only',
    );
    assert.equal(
      ['.github/workflows/example.yml', 'docs/example.yml'].every(isDocumentationPath),
      false,
      'moving a workflow into docs must not be documentation-only',
    );
    assert.equal(
      ['docs/old.md', 'docs/new.md'].every(isDocumentationPath),
      true,
      'moving documentation within docs must remain documentation-only',
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
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
    assert.ok(
      'workflow_dispatch' in workflow.on,
      'ci.yml must expose a manual trigger for the pgvector benchmark',
    );
    const changes = workflow.jobs?.changes;
    const impeccableWorker = workflow.jobs?.['impeccable-worker'];
    const impeccableResult = workflow.jobs?.impeccable;
    const lintWorker = workflow.jobs?.['lint-worker'];
    const productionBuildWorker = workflow.jobs?.['production-build-worker'];
    const lintResult = workflow.jobs?.lint;
    const productionBuildResult = workflow.jobs?.['production-build'];
    const workflowPolicyResult = workflow.jobs?.['workflow-policy'];
    const workerRuntimeResult = workflow.jobs?.['worker-runtime'];
    const shards = workflow.jobs?.['unit-test-shards'];
    const unitTestsResult = workflow.jobs?.['unit-tests'];
    const postgresIntegration = workflow.jobs?.['postgres-integration'];
    const expensiveStepCondition = "needs.changes.outputs.docs_only != 'true'";
    assert.ok(
      changes && impeccableWorker && impeccableResult && lintWorker &&
        productionBuildWorker && lintResult && productionBuildResult &&
        workflowPolicyResult && workerRuntimeResult && shards && unitTestsResult &&
        postgresIntegration,
      'ci.yml must classify changes, isolate expensive workers, and expose every required check',
    );
    assert.equal(changes.name, 'Classify changes', 'change classification must retain its stable name');
    assert.deepEqual(
      changes.outputs,
      {
        docs_only: '${{ steps.classify.outputs.docs_only }}',
        impeccable_changed: '${{ steps.classify.outputs.impeccable_changed }}',
        workflow_policy_changed: '${{ steps.classify.outputs.workflow_policy_changed }}',
      },
      'change classification must expose its fail-closed result',
    );
    const classifier = changes.steps?.find((step) => step.id === 'classify');
    assert.ok(classifier, 'ci.yml must classify changed files');
    for (const invariant of [
      'github.event.pull_request.base.sha || github.event.before',
      'github.event.pull_request.head.sha || github.sha',
      '0000000000000000000000000000000000000000',
      'git cat-file -e "${BASE_SHA}^{commit}"',
      'git diff --no-renames --name-only --diff-filter=ACDMRTUXB -z "${BASE_SHA}" "${HEAD_SHA}"',
      'docs/*|README.md|CODE_OF_CONDUCT.md|CONTRIBUTING.md|DESIGN.md|PRODUCT.md|SECURITY.md|SUPPORT.md',
      '.github/agents/*|.github/hooks/impeccable.json|.github/skills/impeccable/*|.github/workflows/ci.yml|.impeccable/live/config.json|scripts/validate-impeccable.mjs|src/app/layout.tsx',
      '.github/workflows/*|.impeccable/live/config.json|package.json|package-lock.json|scripts/validate-workflows.mjs',
      'echo "impeccable_changed=${impeccable_changed}" >> "$GITHUB_OUTPUT"',
      'echo "workflow_policy_changed=${workflow_policy_changed}" >> "$GITHUB_OUTPUT"',
      'if [[ "${found_change}" != "true" ]]',
    ]) {
      assert.ok(source.includes(invariant), `documentation-only classification must enforce ${invariant}`);
    }
    const impeccableLiveConfig = JSON.parse(
      await readFile(path.resolve('.impeccable', 'live', 'config.json'), 'utf8'),
    );
    for (const target of impeccableLiveConfig.files ?? []) {
      assert.ok(
        source.includes(target),
        `Impeccable change classification must include configured live target ${target}`,
      );
    }
    assert.deepEqual(
      impeccableWorker.needs,
      ['changes'],
      'Impeccable worker must depend on change classification',
    );
    for (const invariant of [
      'always()',
      "needs.changes.result != 'success'",
      "needs.changes.outputs.impeccable_changed != 'false'",
    ]) {
      assert.ok(
        impeccableWorker.if.includes(invariant),
        `Impeccable worker must enforce ${invariant}`,
      );
    }
    assert.equal(
      impeccableWorker.name,
      'Impeccable integration worker',
      'Impeccable worker must not claim the required check name',
    );
    assert.ok(
      impeccableWorker.steps?.some((step) => step.run === 'node scripts/validate-impeccable.mjs'),
      'Impeccable validation must run directly without installing dependencies',
    );
    assert.equal(
      impeccableWorker.steps?.some((step) =>
        step.run === 'npm ci --no-audit --no-fund' ||
        step.uses?.startsWith('actions/cache/')
      ),
      false,
      'Impeccable validation must not restore dependencies or npm caches',
    );
    assert.deepEqual(lintWorker.needs, ['changes'], 'lint worker must depend on change classification');
    assert.deepEqual(
      productionBuildWorker.needs,
      ['changes'],
      'production build worker must depend on change classification',
    );
    assert.deepEqual(shards.needs, ['changes'], 'unit-test shards must depend on change classification');
    for (const [jobName, job] of Object.entries({
      'lint-worker': lintWorker,
      'production-build-worker': productionBuildWorker,
      'unit-test-shards': shards,
    })) {
      for (const invariant of [
        'always()',
        "needs.changes.result != 'success'",
        expensiveStepCondition,
      ]) {
        assert.ok(job.if.includes(invariant), `${jobName} must enforce ${invariant}`);
      }
      assert.equal(
        job.steps?.some((step) => step.name?.startsWith('Skip ')),
        false,
        `${jobName} must skip documentation-only work before allocating a runner`,
      );
    }
    assert.deepEqual(
      shards.strategy?.matrix?.shard,
      [1, 2, 3, 4],
      'ci.yml must run four unit-test shards',
    );
    assert.equal(shards.strategy?.['fail-fast'], false, 'unit-test shards must all report their result');
    assert.equal(
      postgresIntegration.services?.postgres?.image,
      'pgvector/pgvector:0.8.6-pg17-bookworm@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f',
      'PostgreSQL integration must use the approved pgvector image digest',
    );
    assert.equal(
      postgresIntegration['timeout-minutes'],
      120,
      'PostgreSQL integration must budget for the required 1536-dimension 100k gate',
    );
    const pgvectorBootstrap = postgresIntegration.steps?.find(
      (step) => step.name === 'Bootstrap and verify pgvector',
    );
    assert.ok(
      pgvectorBootstrap?.run?.includes('CREATE EXTENSION IF NOT EXISTS vector'),
      'PostgreSQL integration must bootstrap pgvector through its administrator',
    );
    assert.ok(
      pgvectorBootstrap?.run?.includes(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      ) && pgvectorBootstrap.run.includes('"0.8.6"'),
      'PostgreSQL integration must assert pgvector 0.8.6',
    );
    for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
      assert.ok(
        pgvectorBootstrap?.env?.[name],
        `PostgreSQL extension bootstrap must provide ${name}`,
      );
    }
    const pgvectorBenchmark = postgresIntegration.steps?.find(
      (step) => step.name === 'Run pgvector 100k benchmark gate',
    );
    const pgvectorContainer = postgresIntegration.steps?.find(
      (step) => step.name === 'Locate pgvector service container',
    );
    assert.ok(
      pgvectorContainer?.run?.includes('MC_BENCHMARK_POSTGRES_CONTAINER='),
      'PostgreSQL integration must expose its service container for pg_dump and pg_restore',
    );
    assert.equal(
      pgvectorBenchmark?.run,
      'npm run --silent benchmark:postgres-vector',
      'PostgreSQL integration must run the repository pgvector benchmark',
    );
    assert.equal(
      pgvectorBenchmark?.if,
      "github.event_name == 'workflow_dispatch'",
      'The pgvector benchmark must run only when CI is manually dispatched',
    );
    assert.equal(
      pgvectorBenchmark?.env?.MC_BENCHMARK_DIMENSIONS,
      1536,
      'CI must run the production-representative pgvector dimension',
    );
    assert.ok(
      pgvectorBenchmark?.env?.MC_BENCHMARK_POSTGRES_URL,
      'pgvector benchmark must receive a dedicated database URL',
    );
    const workflowPolicy = lintWorker.steps?.find((step) => step.name === 'Validate workflow policy');
    assert.ok(workflowPolicy, 'lint validation must include the workflow policy check');
    for (const invariant of [
      "needs.changes.result != 'success'",
      "needs.changes.outputs.workflow_policy_changed != 'false'",
    ]) {
      assert.ok(workflowPolicy.if.includes(invariant), `workflow policy validation must enforce ${invariant}`);
    }
    assert.equal(workflowPolicy.run, 'npm run ci:workflows', 'workflow policy validation must use its npm script');
    assert.ok(
      lintWorker.steps?.some((step) => step.run === 'npm run lint'),
      'lint worker must run the repository linter',
    );
    assert.ok(
      productionBuildWorker.steps?.some((step) => step.run === 'npm run build'),
      'production build worker must run the production build',
    );
    const workerSmoke = productionBuildWorker.steps?.find(
      (step) => step.name === 'Smoke-test production worker runtime',
    );
    assert.ok(workerSmoke, 'production validation must smoke-test the packaged worker runtime');
    assert.equal(
      workerSmoke.run,
      'MC_WORKER_RUNTIME_SOURCE=.next/standalone node scripts/smoke-sync-worker-runtime.mjs',
      'worker runtime smoke test must reuse the production standalone artifact',
    );
    assert.ok(
      shards.steps?.some((step) =>
        step.run === 'npm test -- --shard=${{ matrix.shard }}/4'
      ),
      'unit-test shards must partition the Vitest suite',
    );

    const requiredGates = {
      impeccable: {
        job: impeccableResult,
        name: 'Impeccable integration',
        needs: ['changes', 'impeccable-worker'],
        workerResult: '${{ needs.impeccable-worker.result }}',
        decisionEnv: 'CHANGE_REQUIRED',
        decisionValue: '${{ needs.changes.outputs.impeccable_changed }}',
      },
      lint: {
        job: lintResult,
        name: 'Lint',
        needs: ['changes', 'lint-worker'],
        workerResult: '${{ needs.lint-worker.result }}',
        decisionEnv: 'DOCS_ONLY',
        decisionValue: '${{ needs.changes.outputs.docs_only }}',
      },
      'production-build': {
        job: productionBuildResult,
        name: 'Production build',
        needs: ['changes', 'production-build-worker'],
        workerResult: '${{ needs.production-build-worker.result }}',
        decisionEnv: 'DOCS_ONLY',
        decisionValue: '${{ needs.changes.outputs.docs_only }}',
      },
      'workflow-policy': {
        job: workflowPolicyResult,
        name: 'Workflow policy',
        needs: ['changes', 'lint-worker'],
        workerResult: '${{ needs.lint-worker.result }}',
        decisionEnv: 'DOCS_ONLY',
        decisionValue: '${{ needs.changes.outputs.docs_only }}',
      },
      'worker-runtime': {
        job: workerRuntimeResult,
        name: 'Worker runtime',
        needs: ['changes', 'production-build-worker'],
        workerResult: '${{ needs.production-build-worker.result }}',
        decisionEnv: 'DOCS_ONLY',
        decisionValue: '${{ needs.changes.outputs.docs_only }}',
      },
      'unit-tests': {
        job: unitTestsResult,
        name: 'Unit tests',
        needs: ['changes', 'unit-test-shards'],
        workerResult: '${{ needs.unit-test-shards.result }}',
        decisionEnv: 'DOCS_ONLY',
        decisionValue: '${{ needs.changes.outputs.docs_only }}',
      },
    };
    assert.deepEqual(
      Object.values(requiredGates).map(({ name }) => name).sort(),
      [
        'Impeccable integration',
        'Lint',
        'Production build',
        'Unit tests',
        'Worker runtime',
        'Workflow policy',
      ],
      'ci.yml must preserve every active ruleset context',
    );
    for (const [jobName, gate] of Object.entries(requiredGates)) {
      assert.equal(gate.job.name, gate.name, `${jobName} must retain its required check name`);
      assert.equal(gate.job.if, 'always()', `${jobName} must materialize after skipped or failed needs`);
      assert.deepEqual(gate.job.needs, gate.needs, `${jobName} must depend on classification and its worker`);
      assert.equal(gate.job.steps?.length, 1, `${jobName} must remain a cheap summary gate`);
      const [step] = gate.job.steps;
      assert.equal(
        step.env?.CLASSIFICATION_RESULT,
        '${{ needs.changes.result }}',
        `${jobName} must fail closed when classification fails`,
      );
      assert.equal(step.env?.WORKER_RESULT, gate.workerResult, `${jobName} must inspect its worker result`);
      assert.equal(
        step.env?.[gate.decisionEnv],
        gate.decisionValue,
        `${jobName} must use the classifier to decide whether a worker was required`,
      );
      for (const invariant of [
        'if [[ "${CLASSIFICATION_RESULT}" != "success" ]]',
        'exit 1',
        `case "\${${gate.decisionEnv}}" in`,
        'test "${WORKER_RESULT}" = "success"',
        'test "${WORKER_RESULT}" = "skipped"',
        '*) echo "Invalid ',
      ]) {
        assert.ok(step.run.includes(invariant), `${jobName} gate must enforce ${invariant}`);
      }
    }

    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (
        jobName === 'changes' ||
        jobName === 'impeccable-worker' ||
        jobName === 'impeccable' ||
        jobName === 'lint' ||
        jobName === 'production-build' ||
        jobName === 'workflow-policy' ||
        jobName === 'worker-runtime' ||
        jobName === 'unit-tests'
      ) continue;
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
      lintWorker.steps?.filter((step) =>
        step.uses?.startsWith('actions/cache/save@')
      ) ?? [];
    assert.equal(cacheSaves.length, 1, 'ci.yml must use one designated npm cache writer');
    for (const invariant of [
      "github.ref == 'refs/heads/main'",
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

await validateRenameClassification();
assert.ok(hasPullRequestWorkflow, 'At least one workflow must validate pull requests');
console.log(`Validated ${workflowFiles.length} workflow files`);
