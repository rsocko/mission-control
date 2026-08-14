import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface ComposeService {
  depends_on?: Record<string, { condition?: string }>;
  environment?: string[];
  healthcheck?: { test?: string[] };
  networks?: string[];
}

interface ComposeConfiguration {
  services: Record<string, ComposeService>;
}

const compose = parse(
  readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8'),
) as ComposeConfiguration;

describe('local Docker Compose startup ordering', () => {
  it('keeps the web healthcheck DB-free', () => {
    expect(compose.services['mission-control'].healthcheck?.test).toEqual([
      'CMD',
      'wget',
      '--spider',
      '-q',
      'http://127.0.0.1:3099/api/health/live',
    ]);
  });

  it('starts the worker after web health and polls bounded web readiness', () => {
    const worker = compose.services['mission-control-worker'];

    expect(worker.depends_on?.['mission-control']?.condition).toBe(
      'service_healthy',
    );
    expect(worker.environment).toEqual(expect.arrayContaining([
      'MC_WEB_READINESS_URL=http://mission-control:3099/api/health/ready',
      'MC_WEB_READINESS_MAX_ATTEMPTS=${MC_WEB_READINESS_MAX_ATTEMPTS:-30}',
      'MC_WEB_READINESS_RETRY_INTERVAL_MS=${MC_WEB_READINESS_RETRY_INTERVAL_MS:-2000}',
      'MC_WEB_READINESS_REQUEST_TIMEOUT_MS=${MC_WEB_READINESS_REQUEST_TIMEOUT_MS:-2000}',
    ]));
    expect(worker.networks).toContain('traefik');
  });
});
