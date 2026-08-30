import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface ComposeConfiguration {
  services: {
    'postgres-vector': {
      profiles: string[];
      image: string;
      environment: Record<string, string>;
      entrypoint: string[];
      shm_size: string;
      healthcheck: { test: string[] };
    };
  };
}

const compose = parse(
  readFileSync(join(process.cwd(), 'docker-compose.pgvector.yml'), 'utf8'),
) as ComposeConfiguration;

describe('opt-in PostgreSQL vector environment', () => {
  it('pins pgvector and keeps it behind an explicit profile', () => {
    const postgres = compose.services['postgres-vector'];

    expect(postgres.profiles).toEqual(['postgres-vector']);
    expect(postgres.image).toBe(
      'pgvector/pgvector:0.8.6-pg17-bookworm@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f',
    );
    expect(postgres.environment.POSTGRES_DB).toContain('mission_control_vector_dev');
    expect(postgres.shm_size).toBe('2gb');
    expect(postgres.entrypoint.join('\n')).toContain(
      'CREATE EXTENSION IF NOT EXISTS vector',
    );
    expect(postgres.healthcheck.test.join('\n')).toContain(
      "extname = 'vector'",
    );
    expect(postgres.healthcheck.test.join('\n')).toContain('0.8.6');
  });

  it('runs the required 1536-dimension gate with container memory and dump tools', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf8',
    );

    expect(workflow).toContain('timeout-minutes: 120');
    expect(workflow).toContain('MC_BENCHMARK_DIMENSIONS: 1536');
    expect(workflow).toContain('MC_BENCHMARK_QUERY_RUNS: 20');
    expect(workflow).toContain('MC_BENCHMARK_POSTGRES_CONTAINER=');
    expect(workflow).toContain('npm run --silent benchmark:postgres-vector');
  });
});
