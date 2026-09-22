import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

const bridgeRoot = resolve(process.cwd(), 'clients/power-automate-todo-bridge');

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(bridgeRoot, relativePath), 'utf8'));
}

function validator(relativePath: string) {
  const ajv = new Ajv2020({ allErrors: true });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => !Number.isNaN(Date.parse(value)),
  });
  return ajv.compile(readJson(relativePath));
}

describe('Power Automate work To Do bridge', () => {
  it('validates pull requests and rejects invalid cursors or extra fields', () => {
    const validate = validator('schemas/pull-request.schema.json');
    const request = {
      schemaVersion: '1.0',
      connectorInstanceId: 'work-todo',
      requestedAt: '2026-08-07T18:00:00Z',
    };

    expect(validate(request)).toBe(true);
    expect(validate({ ...request, requestedAt: 'yesterday' })).toBe(false);
    expect(validate({ ...request, triggerUrl: 'must-not-cross-contract' })).toBe(false);
  });

  it('accepts a bounded full snapshot and rejects extra task fields', () => {
    const validate = validator('schemas/pull-response.schema.json');
    const snapshot = {
      schemaVersion: '1.0',
      connectorInstanceId: 'work-todo',
      syncTimestamp: '2026-08-07T18:00:00Z',
      isFullSnapshot: true,
      lists: [{
        id: 'list-1',
        displayName: 'Tasks',
        wellKnownListName: 'defaultList',
        isOwner: true,
        isShared: false,
        tasks: [{
          id: 'task-1',
          title: 'Review the bridge',
          status: 'notStarted',
          importance: 'normal',
          createdDateTime: '2026-08-07T17:00:00Z',
          lastModifiedDateTime: '2026-08-07T17:30:00Z',
        }],
      }],
    };

    expect(validate(snapshot)).toBe(true);

    const taskWithUnexpectedField = snapshot.lists[0].tasks[0] as unknown as Record<string, unknown>;
    taskWithUnexpectedField.unexpectedCorporateField = 'must not cross the boundary';
    expect(validate(snapshot)).toBe(false);
  });

  it('requires write-back idempotency keys and keeps delete disabled by default', () => {
    const validate = validator('schemas/writeback-request.schema.json');
    const request = {
      schemaVersion: '1.0',
      connectorInstanceId: 'work-todo',
      requestedAt: '2026-08-07T18:00:00Z',
      leaseId: '123e4567-e89b-42d3-a456-426614174000',
      leaseExpiresAt: '2026-08-07T18:05:00Z',
      allowDelete: false,
      changes: [{
        idempotencyKey: 'task-1:2026-08-07T18:00:00Z',
        sourceId: 'list-1:task-1',
        listId: 'list-1',
        taskId: 'task-1',
        operation: 'update',
        fields: {
          status: 'inProgress',
        },
      }],
    };

    expect(validate(request)).toBe(true);
    const withoutKey = structuredClone(request) as Record<string, unknown> & {
      changes: Array<Record<string, unknown>>;
    };
    delete withoutKey.changes[0].idempotencyKey;
    expect(validate(withoutKey)).toBe(false);

    const updateWithoutFields = structuredClone(request) as Record<string, unknown> & {
      changes: Array<Record<string, unknown>>;
    };
    delete updateWithoutFields.changes[0].fields;
    expect(validate(updateWithoutFields)).toBe(false);
    expect(validate({ ...request, changes: [] })).toBe(false);

    expect(readJson('config.example.json')).toMatchObject({ allowDelete: false });
  });

  it('validates per-item write-back outcomes', () => {
    const validate = validator('schemas/writeback-response.schema.json');
    const response = {
      schemaVersion: '1.0',
      connectorInstanceId: 'work-todo',
      leaseId: '123e4567-e89b-42d3-a456-426614174000',
      processedAt: '2026-08-07T18:01:00Z',
      results: [
        {
          idempotencyKey: 'task-1:2026-08-07T18:00:00Z',
          sourceId: 'list-1:task-1',
          status: 'succeeded',
        },
        {
          idempotencyKey: 'task-2:2026-08-07T18:00:00Z',
          sourceId: 'list-1:task-2',
          status: 'failed',
          errorCode: 'TODO_UPDATE_FAILED',
          errorMessage: 'Synthetic connector failure',
        },
      ],
    };

    expect(validate(response)).toBe(true);
    expect(validate({ ...response, schemaVersion: undefined })).toBe(false);
    expect(validate({
      ...response,
      results: Array.from({ length: 101 }, (_, index) => ({
        idempotencyKey: `task-${index}:attempt-1`,
        sourceId: `list-1:task-${index}`,
        status: 'skipped',
      })),
    })).toBe(false);
  });

  it('uses current Microsoft To-Do connector operations in both recipes', () => {
    const pullRecipe = JSON.stringify(readJson('flows/pull.flow.recipe.json'));
    const writebackRecipe = JSON.stringify(readJson('flows/writeback.flow.recipe.json'));

    expect(pullRecipe).toContain('GetAllTodoListsV2');
    expect(pullRecipe).toContain('ListToDosByFolderV2');
    expect(pullRecipe).toContain('"syncMode":"full-snapshot"');
    expect(pullRecipe).toContain('LIST_TOO_LARGE');
    expect(writebackRecipe).toContain('UpdateToDoV2');
    expect(writebackRecipe).toContain('DeleteToDoV2');
    expect(writebackRecipe).toContain('MC Work Todo Allow Delete');
    expect(writebackRecipe).toContain('"concurrency":1');
  });

  it('defines the extended Graph tier without routing attachment bytes through Scout', () => {
    const pullRecipe = JSON.stringify(readJson('flows/extended-pull.flow.recipe.json'));
    const writebackRecipe = JSON.stringify(readJson('flows/extended-writeback.flow.recipe.json'));
    const extendedDesign = readFileSync(resolve(bridgeRoot, 'EXTENDED-BRIDGE.md'), 'utf8');

    expect(pullRecipe).toContain('HTTP With Microsoft Entra ID');
    expect(pullRecipe).toContain('Tasks.ReadWrite');
    expect(pullRecipe).toContain('request.listDeltaLink');
    expect(pullRecipe).toContain('request.taskDeltaLinks[listId]');
    expect(pullRecipe).toContain('@odata.nextLink');
    expect(pullRecipe).toContain('Retry-After');
    expect(pullRecipe).toContain('RESET_REQUIRED');
    expect(pullRecipe).toContain('Never fetch or return contentBytes through Scout');
    expect(writebackRecipe).toContain('"attachmentUpload":"Disabled');
    expect(writebackRecipe).toContain('"concurrency":1');
    expect(extendedDesign).toContain('No customer-created application/client ID');
    expect(extendedDesign).toContain('Text hashtags');
    expect(extendedDesign.toLowerCase()).toContain('attachment bytes never pass through scout');
  });

  it('validates the extended delta request and bounded response contracts', () => {
    const validateRequest = validator('schemas/extended-pull-request.schema.json');
    const validateResponse = validator('schemas/extended-pull-response.schema.json');
    const request = {
      schemaVersion: '1.1',
      connectorInstanceId: 'work-todo',
      requestedAt: '2026-08-07T18:00:00Z',
      selectedListIds: ['list-1'],
      listDeltaLink: null,
      taskDeltaLinks: {
        'list-1': null,
      },
    };
    const response = {
      schemaVersion: '1.1',
      connectorInstanceId: 'work-todo',
      syncTimestamp: '2026-08-07T18:01:00Z',
      syncMode: 'delta',
      reset: true,
      complete: true,
      listDeltaLink: 'https://graph.microsoft.com/v1.0/me/todo/lists/delta?$deltatoken=opaque',
      lists: [{
        id: 'list-1',
        removed: false,
        displayName: 'Tasks',
        taskDeltaLink: 'https://graph.microsoft.com/v1.0/me/todo/lists/list-1/tasks/delta?$deltatoken=opaque',
        tasks: [{
          id: 'task-1',
          removed: false,
          etag: 'W/"opaque"',
          title: 'Review #bridge',
          status: 'waitingOnOthers',
          importance: 'normal',
          createdDateTime: '2026-08-07T17:00:00Z',
          lastModifiedDateTime: '2026-08-07T17:30:00Z',
          categories: ['MC:Waiting'],
          checklistItems: [],
          linkedResources: [],
          attachments: [{
            id: 'attachment-1',
            name: 'design.pdf',
            contentType: 'application/pdf',
            size: 1024,
          }],
        }],
      }],
    };

    expect(validateRequest(request)).toBe(true);
    expect(validateResponse(response)).toBe(true);
    expect(validateResponse({
      ...response,
      lists: [{
        ...response.lists[0],
        tasks: [{
          ...response.lists[0].tasks[0],
          linkedResources: [{
            id: 'linked-resource-without-url',
            applicationName: 'Native app',
            displayName: 'Related item',
          }],
        }],
      }],
    })).toBe(true);
    expect(validateResponse({
      ...response,
      lists: [{
        ...response.lists[0],
        tasks: [{
          ...response.lists[0].tasks[0],
          contentBytes: 'must-not-cross-scout',
        }],
      }],
    })).toBe(false);
  });

  it('ships the Scout courier disabled and forbids interpretation of task data', () => {
    const automation = readJson('scout/work-todo-bridge-sync.template.json') as {
      enabled: boolean;
      steps: Array<{ prompt: string }>;
    };
    const prompts = automation.steps.map((step) => step.prompt).join('\n');

    expect(automation.enabled).toBe(false);
    expect(prompts).toContain('Pass the entire response unchanged');
    expect(prompts).toContain('Do not summarize, filter, rename, prioritize, deduplicate');
    expect(prompts).toContain('never print');
    expect(prompts).toContain('Acknowledge only source IDs whose result status is "succeeded"');
    expect(prompts).toContain('Leave failed and skipped items pending');
    expect(prompts).toContain('mc_todo_sync_ingest');
    expect(prompts).toContain('mc_todo_sync_changes');
    expect(prompts).toContain('mc_todo_sync_ack');
  });
});
