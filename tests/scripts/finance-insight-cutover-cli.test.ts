import { describe, expect, it, vi } from 'vitest';
import {
  FinanceInsightCutoverCliError,
  parseFinanceInsightCutoverCli,
  runFinanceInsightCutoverCli,
} from '../../scripts/finance-insight-cutover';

const environment = {
  MC_ORIGIN: 'https://mission-control.example',
  MC_API_KEY: 'invented-operator-key',
};

function options(command: 'readiness' | 'enable' | 'rollback') {
  return parseFinanceInsightCutoverCli([
    command,
    '--connector',
    'finance-one',
    '--source-generation',
    'generation-7',
    ...(command === 'readiness'
      ? []
      : ['--idempotency-key', `finance-cutover-${command}-0001`]),
  ], environment);
}

describe('Finance Insight cutover CLI', () => {
  it('requires an explicit connector, generation, and mutation idempotency key', () => {
    expect(() => parseFinanceInsightCutoverCli([
      'readiness',
      '--source-generation',
      'generation-7',
    ], environment)).toThrow('--connector is required');
    expect(() => parseFinanceInsightCutoverCli([
      'readiness',
      '--connector',
      'finance-one',
    ], environment)).toThrow('--source-generation is required');
    expect(() => parseFinanceInsightCutoverCli([
      'enable',
      '--connector',
      'finance-one',
      '--source-generation',
      'generation-7',
    ], environment)).toThrow('--idempotency-key is required');
  });

  it('refuses to transmit the operator key over non-loopback HTTP', () => {
    expect(() => parseFinanceInsightCutoverCli([
      'readiness',
      '--origin',
      'http://mission-control.example',
      '--connector',
      'finance-one',
      '--source-generation',
      'generation-7',
    ], environment)).toThrow('--origin must use HTTPS unless it targets loopback');
  });

  it('requests sanitized readiness for the exact connector and generation', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      connector: { id: 'finance-one', enabled: true },
      publication: { sourceGeneration: 'generation-7', sourceSequence: 7 },
      readiness: { ready: true, blockers: [] },
    }));

    await expect(runFinanceInsightCutoverCli(options('readiness'), fetchMock))
      .resolves.toMatchObject({ readiness: { ready: true } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      'https://mission-control.example/api/connectors/finance-one/finance-operations'
      + '?sourceGeneration=generation-7',
    );
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('x-mc-api-key')).toBe('invented-operator-key');
  });

  it.each([
    ['enable', 'enable-insight-cutover'],
    ['rollback', 'rollback-insight-cutover'],
  ] as const)('sends an authorized, idempotent %s command', async (command, action) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      status: command === 'enable' ? 'enabled' : 'rolled-back',
      replayed: false,
    }));

    await runFinanceInsightCutoverCli(options(command), fetchMock);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-mc-api-key')).toBe('invented-operator-key');
    expect(headers.get('idempotency-key')).toBe(`finance-cutover-${command}-0001`);
    expect(JSON.parse(String(init?.body))).toEqual({
      action,
      sourceGeneration: 'generation-7',
    });
  });

  it('fails closed when programmatic mutation options omit idempotency', async () => {
    await expect(runFinanceInsightCutoverCli({
      ...options('enable'),
      idempotencyKey: undefined,
    }, vi.fn<typeof fetch>()))
      .rejects.toThrow('idempotency key is required for enable and rollback');
  });

  it.each([
    'forbidden',
    'finance_insight_connector_unavailable',
    'finance_insight_cutover_generation_stale',
  ])('preserves the stable API error %s', async (error) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { error },
      { status: error === 'forbidden' ? 403 : 409 },
    ));

    await expect(runFinanceInsightCutoverCli(options('enable'), fetchMock))
      .rejects.toEqual(expect.objectContaining<Partial<FinanceInsightCutoverCliError>>({
        message: error,
        exitCode: 1,
      }));
  });
});
