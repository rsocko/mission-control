import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { PostgresDatabaseHealthProbe } from '@/db/postgres/health';
import { createPostgresRuntimeTelemetryPersistence } from '@/db/postgres/telemetry-runtime';
import {
  clearRuntimeHealthPersistence,
  registerRuntimeHealthPersistence,
  type RuntimeHealthPersistence,
} from '@/lib/telemetry/database-health-runtime';
import {
  clearRuntimeTelemetryPersistence,
  registerRuntimeTelemetryPersistence,
  type RuntimeTelemetryPersistence,
} from '@/lib/telemetry/runtime-persistence';
import { PostgresHealthSnapshotStore } from '@/lib/telemetry/postgres-health-snapshot-store';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import { runtimeMetricsFixture } from '../contracts/runtime-telemetry-persistence.contract';

vi.unmock('drizzle-orm');
vi.mock('@/lib/public-demo', () => ({
  isPublicDemoMode: () => false,
}));
vi.mock('@/lib/runtime/lifecycle', () => ({
  getRuntimeLifecycleSnapshot: () => ({
    status: 'ready',
    reason: null,
    startedAt: '2026-09-04T00:00:00.000Z',
    drainingAt: null,
    release: 'postgres-route-integration',
    role: 'web',
    activeOperations: {},
    previousExit: null,
  }),
  isRuntimeReady: () => true,
  recordRuntimeMemoryDiagnostics: vi.fn(),
  requestRuntimeRestart: vi.fn(),
}));

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const integration = describe.skipIf(!connectionString);

integration('PostgreSQL runtime observability routes integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-observability-routes-test',
          }),
        }
      : {}),
  });
  const instanceId = `postgres-route-${randomUUID()}`;
  const sampledAt = new Date().toISOString();
  const metrics = runtimeMetricsFixture(sampledAt, 'web');
  let health: RuntimeHealthPersistence | null = null;
  let telemetry: RuntimeTelemetryPersistence | null = null;
  let backendInitialized = false;

  beforeAll(async () => {
    if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
    assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    backendInitialized = true;

    telemetry = createPostgresRuntimeTelemetryPersistence(backend.context.pool);
    health = {
      databaseHealthProbe: new PostgresDatabaseHealthProbe(backend.context.pool),
      createHealthSnapshotStore: <TSummary>() => (
        new PostgresHealthSnapshotStore<TSummary>(backend.context.db)
      ),
    };
    registerRuntimeHealthPersistence(health);
    registerRuntimeTelemetryPersistence(telemetry);

    await backend.context.pool.query(
      `INSERT INTO runtime_telemetry_instances (
        instance_id, role, pid, started_at, last_seen_at, restart_count,
        build_sha, runtime_mode, high_water_metrics
      ) VALUES ($1, 'web', $2, $3, $3, NULL, $4, 'test', $5)`,
      [
        instanceId,
        metrics.process.pid,
        sampledAt,
        metrics.buildSha,
        JSON.stringify(metrics.memory.instanceHighWater),
      ],
    );
    await backend.context.pool.query(
      `INSERT INTO runtime_telemetry_samples (
        instance_id, role, pid, sampled_at, resolution_seconds, metrics
      ) VALUES ($1, 'web', $2, $3, 10, $4)`,
      [instanceId, metrics.process.pid, sampledAt, JSON.stringify(metrics)],
    );
  }, 120_000);

  afterAll(async () => {
    if (telemetry) clearRuntimeTelemetryPersistence(telemetry);
    if (health) clearRuntimeHealthPersistence(health);
    if (!backendInitialized) return;
    await backend.context.pool.query(
      'DELETE FROM runtime_telemetry_samples WHERE instance_id = $1',
      [instanceId],
    );
    await backend.context.pool.query(
      'DELETE FROM runtime_telemetry_instances WHERE instance_id = $1',
      [instanceId],
    );
    await backend.shutdown();
  });

  it('serves health and telemetry from live PostgreSQL persistence', async () => {
    const [
      liveRoute,
      readyRoute,
      healthRoute,
      runtimeRoute,
      metricsRoute,
      telemetryRoute,
    ] = await Promise.all([
      import('@/app/api/health/live/route'),
      import('@/app/api/health/ready/route'),
      import('@/app/api/health/route'),
      import('@/app/api/health/runtime/route'),
      import('@/app/api/metrics/route'),
      import('@/app/api/telemetry/runtime/route'),
    ]);

    const live = await liveRoute.GET();
    const ready = await readyRoute.GET();
    const healthResponse = await healthRoute.GET();
    const runtime = await runtimeRoute.GET(new Request(
      `http://localhost/api/health/runtime?role=web&since=${encodeURIComponent(sampledAt)}&limit=10`,
    ));
    const metricsResponse = await metricsRoute.GET();
    const telemetryResponse = await telemetryRoute.GET(new Request(
      'http://localhost/api/telemetry/runtime?hours=1',
    ));

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toHaveProperty('snapshot.status');
    expect(runtime.status).toBe(200);
    expect(await runtime.json()).toMatchObject({
      samples: expect.arrayContaining([
        expect.objectContaining({ instanceId }),
      ]),
    });
    expect(metricsResponse.status).toBe(200);
    expect(await metricsResponse.text()).toContain(
      'mission_control_runtime_heartbeat_age_seconds',
    );
    expect(telemetryResponse.status).toBe(200);
    expect(await telemetryResponse.json()).toMatchObject({
      series: expect.arrayContaining([
        expect.objectContaining({ instanceId }),
      ]),
      instances: expect.arrayContaining([
        expect.objectContaining({ instanceId }),
      ]),
    });
  });
});
