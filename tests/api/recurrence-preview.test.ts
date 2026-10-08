import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/recurrence/preview/route';

function previewRequest(body: unknown) {
  return new Request('http://localhost/api/recurrence/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/recurrence/preview', () => {
  it('projects skip-date exceptions without creating persistent occurrences', async () => {
    const response = await POST(previewRequest({
      recurrence: 'daily',
      mode: 'schedule',
      startDate: '2099-01-01',
      timezone: 'UTC',
      options: {
        skipDates: ['2099-01-01'],
        catchUp: 'latest',
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'success',
      conditional: false,
      occurrences: [
        { localDate: '2099-01-02' },
        { localDate: '2099-01-03' },
        { localDate: '2099-01-04' },
        { localDate: '2099-01-05' },
        { localDate: '2099-01-06' },
      ],
    });
  });

  it('labels completion-based projections as conditional', async () => {
    const response = await POST(previewRequest({
      recurrence: 'weekly',
      mode: 'completion',
      startDate: '2026-01-01',
      timezone: 'UTC',
      options: {
        skipDates: [],
        catchUp: 'none',
      },
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'success',
      conditional: true,
    });
    expect(body.occurrences).toHaveLength(1);
  });

  it('rejects malformed preview input', async () => {
    const response = await POST(previewRequest({
      recurrence: 'daily',
      mode: 'schedule',
      startDate: 'not-a-date',
      timezone: 'UTC',
      options: { skipDates: [], catchUp: 'latest' },
    }));

    expect(response.status).toBe(400);
  });

  it('returns an invalid result for a tampered canonical rule', async () => {
    const response = await POST(previewRequest({
      recurrence: 'daily',
      mode: 'schedule',
      startDate: '2026-09-21',
      timezone: 'UTC',
      options: { skipDates: [], catchUp: 'latest' },
      rule: {
        version: 1,
        series: { id: 'not-a-series-id', identity: {} },
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid',
    });
  });
});
