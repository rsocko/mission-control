import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({
  default: {
    update: vi.fn(),
  },
}));

vi.mock('@/lib/connectors/microsoft-todo/graph-client', () => ({
  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
  SUBSTRATE_BASE_URL: 'https://outlook.office.com',
  createGraphClient: vi.fn(),
}));

import { buildMicrosoftRecurrencePattern } from '@/lib/connectors/microsoft-todo';
import {
  getRecurrencePatternIdentity,
  mapGraphTask,
  mapSubstrateTask,
  parseRecurrencePattern,
  parseSubstrateRecurrence,
} from '@/lib/connectors/microsoft-todo/task-transformer';

describe('Microsoft To Do recurrence serialization', () => {
  it('serializes custom day intervals', () => {
    expect(buildMicrosoftRecurrencePattern('every 3 days', '2026-08-03')).toEqual({
      range: { type: 'noEnd', startDate: '2026-08-03' },
      pattern: { type: 'daily', interval: 3 },
    });
  });

  it('serializes selected weekdays', () => {
    expect(
      buildMicrosoftRecurrencePattern(
        'weekly (monday, wednesday, friday)',
        '2026-08-03',
      ),
    ).toEqual({
      range: { type: 'noEnd', startDate: '2026-08-03' },
      pattern: {
        type: 'weekly',
        interval: 1,
        daysOfWeek: ['monday', 'wednesday', 'friday'],
      },
    });
  });

  it('uses date-only values without timezone shifts', () => {
    expect(buildMicrosoftRecurrencePattern('monthly', '2026-08-03')).toEqual({
      range: { type: 'noEnd', startDate: '2026-08-03' },
      pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 3 },
    });
    expect(buildMicrosoftRecurrencePattern('weekly', '2026-08-03')).toEqual({
      range: { type: 'noEnd', startDate: '2026-08-03' },
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] },
    });
  });

  it('round-trips custom weekly and yearly intervals', () => {
    expect(parseRecurrencePattern({
      pattern: {
        type: 'weekly',
        interval: 2,
        daysOfWeek: ['monday', 'wednesday'],
      },
      range: { type: 'noEnd', startDate: '2026-08-03' },
    })).toBe('every 2 weeks (monday, wednesday)');
    expect(parseRecurrencePattern({
      pattern: {
        type: 'absoluteYearly',
        interval: 3,
        dayOfMonth: 3,
        month: 8,
      },
      range: { type: 'noEnd', startDate: '2026-08-03' },
    })).toBe('every 3 years');
  });

  it('preserves recurrence metadata for tasks fetched through Substrate', () => {
    expect(parseSubstrateRecurrence({
      Pattern: { Type: 'daily', Interval: 2 },
      Range: { Type: 'noEnd', StartDate: '2026-08-02' },
    })).toBe('every 2 days');
  });

  it('maps optional Substrate recurrence fields to JSON-safe canonical provenance', () => {
    const task = mapSubstrateTask({
      Id: 'substrate-occurrence-1',
      Subject: 'Water plants',
      Status: 'NotStarted',
      Importance: 'Normal',
      CreatedDateTime: '2026-03-01T14:00:00Z',
      LastModifiedDateTime: '2026-03-01T14:00:00Z',
      DueDateTime: {
        DateTime: '2026-03-02T09:00:00',
        TimeZone: 'America/New_York',
      },
      Recurrence: {
        Pattern: { Type: 'daily', Interval: 2 },
        Range: { Type: 'noEnd', StartDate: '2026-03-02' },
      },
    }, 'list-1', 'Tasks', 'microsoft-todo', 'todo-work');

    expect(task.metadata.canonicalRecurrence).toMatchObject({
      semantics: { pattern: { type: 'daily', interval: 2 } },
      source: {
        raw: {
          pattern: { type: 'daily', interval: 2 },
          range: { type: 'noEnd', startDate: '2026-03-02' },
        },
      },
    });
  });

  it('stores a connector-scoped canonical rule for supported imports', () => {
    const graphTask = {
      id: 'occurrence-1',
      title: 'Water plants',
      status: 'notStarted',
      importance: 'normal',
      createdDateTime: '2026-03-01T14:00:00Z',
      lastModifiedDateTime: '2026-03-01T14:00:00Z',
      dueDateTime: {
        dateTime: '2026-03-02T09:00:00',
        timeZone: 'America/New_York',
      },
      recurrence: {
        pattern: {
          type: 'weekly',
          interval: 1,
          daysOfWeek: ['friday', 'monday'],
        },
        range: {
          type: 'endDate',
          startDate: '2026-03-02',
          endDate: '2026-12-31',
        },
      },
    };
    const work = mapGraphTask(
      graphTask,
      'list-1',
      'Tasks',
      'microsoft-todo',
      'todo-work',
    );
    const personal = mapGraphTask(
      graphTask,
      'list-1',
      'Tasks',
      'microsoft-todo',
      'todo-personal',
    );

    expect(work.metadata.canonicalRecurrence).toMatchObject({
      version: 1,
      semantics: {
        timezone: {
          id: 'America/New_York',
          dstPolicy: 'preserve-wall-clock',
        },
        start: { date: '2026-03-02', localTime: '09:00:00' },
        pattern: {
          type: 'weekly',
          interval: 1,
          daysOfWeek: ['monday', 'friday'],
        },
        end: { type: 'date', date: '2026-12-31' },
      },
      source: {
        owner: 'connector',
        connectorInstanceId: 'todo-work',
        support: { status: 'supported', reasons: [] },
      },
    });
    expect(
      work.metadata.canonicalRecurrence?.series.id,
    ).not.toBe(personal.metadata.canonicalRecurrence?.series.id);
  });

  it('keeps Mission Control series identity stable across provider occurrences', () => {
    const mapOccurrence = (id: string, title: string, interval: number) => mapGraphTask({
      id,
      title,
      body: {
        content: 'Created locally\n\n[Mission Control Task ID: mc-series-1]',
        contentType: 'text',
      },
      status: 'notStarted',
      importance: 'normal',
      createdDateTime: '2026-03-01T14:00:00Z',
      lastModifiedDateTime: '2026-03-01T14:00:00Z',
      dueDateTime: {
        dateTime: '2026-03-02T09:00:00',
        timeZone: 'America/New_York',
      },
      recurrence: {
        pattern: { type: 'daily', interval },
        range: { type: 'noEnd', startDate: '2026-03-02' },
      },
    }, 'list-1', 'Tasks', 'microsoft-todo', 'todo-work');
    const first = mapOccurrence('occurrence-1', 'Water plants', 1);
    const revised = mapOccurrence('occurrence-2', 'Water every plant', 2);

    expect(first.metadata.canonicalRecurrence?.series).toEqual(
      revised.metadata.canonicalRecurrence?.series,
    );
    expect(first.metadata.canonicalRecurrence?.revision.id).not.toBe(
      revised.metadata.canonicalRecurrence?.revision.id,
    );
  });

  it('keeps a provider-owned task series stable across title and cadence edits', () => {
    const mapVersion = (title: string, interval: number) => mapGraphTask({
      id: 'provider-task-1',
      title,
      status: 'notStarted',
      importance: 'normal',
      createdDateTime: '2026-03-01T14:00:00Z',
      lastModifiedDateTime: '2026-03-01T14:00:00Z',
      recurrence: {
        pattern: { type: 'daily', interval },
        range: { type: 'noEnd', startDate: '2026-03-02' },
      },
    }, 'list-1', 'Tasks', 'microsoft-todo', 'todo-work');
    const first = mapVersion('Water plants', 1);
    const revised = mapVersion('Water all plants', 2);

    expect(first.metadata.canonicalRecurrence?.series).toEqual(
      revised.metadata.canonicalRecurrence?.series,
    );
    expect(first.metadata.canonicalRecurrence?.revision.id).not.toBe(
      revised.metadata.canonicalRecurrence?.revision.id,
    );
  });

  it('includes provider wall-clock time in the rule revision', () => {
    const mapAt = (localTime: string) => mapGraphTask({
      id: `occurrence-${localTime}`,
      title: 'Timed recurrence',
      body: {
        content: '[Mission Control Task ID: mc-timed-series]',
        contentType: 'text',
      },
      status: 'notStarted',
      importance: 'normal',
      createdDateTime: '2026-03-01T14:00:00Z',
      lastModifiedDateTime: '2026-03-01T14:00:00Z',
      dueDateTime: {
        dateTime: `2026-03-02T${localTime}:00`,
        timeZone: 'America/New_York',
      },
      recurrence: {
        pattern: { type: 'daily', interval: 1 },
        range: { type: 'noEnd', startDate: '2026-03-02' },
      },
    }, 'list-1', 'Tasks', 'microsoft-todo', 'todo-work');

    const morning = mapAt('09:00');
    const afternoon = mapAt('10:00');
    expect(morning.metadata.canonicalRecurrence?.semantics.start.localTime).toBe('09:00:00');
    expect(morning.metadata.canonicalRecurrence?.revision.id).not.toBe(
      afternoon.metadata.canonicalRecurrence?.revision.id,
    );
  });

  it('does not approximate unsupported relative provider patterns', () => {
    const recurrence = {
      pattern: {
        type: 'relativeMonthly',
        interval: 1,
        daysOfWeek: ['monday'],
      },
      range: { type: 'noEnd', startDate: '2026-03-02' },
    };
    const task = mapGraphTask({
      id: 'relative-occurrence',
      title: 'First Monday review',
      status: 'notStarted',
      importance: 'normal',
      createdDateTime: '2026-03-01T14:00:00Z',
      lastModifiedDateTime: '2026-03-01T14:00:00Z',
      recurrence,
    }, 'list-1', 'Tasks', 'microsoft-todo', 'todo-work');

    expect(parseRecurrencePattern(recurrence)).toBe('custom');
    expect(task.metadata.recurrence).toBe('custom');
    expect(task.metadata.canonicalRecurrence).toMatchObject({
      semantics: { pattern: { type: 'unsupported' } },
      source: {
        support: {
          status: 'unsupported',
          reasons: ['relative_pattern_not_supported'],
        },
        raw: recurrence,
      },
    });
    expect(task.metadata.recurrenceIdentity).toBe(
      getRecurrencePatternIdentity(recurrence),
    );
  });

  it('preserves Graph linked resources for task detail source actions', () => {
    const task = mapGraphTask({
      id: 'flagged-task',
      title: 'Follow up',
      status: 'notStarted',
      importance: 'normal',
      createdDateTime: '2026-08-20T12:00:00Z',
      lastModifiedDateTime: '2026-08-20T12:00:00Z',
      linkedResources: [{
        id: 'email-link',
        applicationName: 'Microsoft Outlook',
        displayName: 'Flagged email',
        webUrl: 'https://outlook.office.com/mail/deeplink/read/id',
      }],
    }, 'flagged-emails', 'Flagged Emails', 'microsoft-todo', 'todo-1', 'flaggedEmails');

    expect(task.metadata.linkedResources).toEqual([{
      id: 'email-link',
      applicationName: 'Microsoft Outlook',
      displayName: 'Flagged email',
      webUrl: 'https://outlook.office.com/mail/deeplink/read/id',
    }]);
  });
});
