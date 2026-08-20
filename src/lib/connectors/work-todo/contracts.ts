import { z } from 'zod';

const dateTimeValueSchema = z.object({
  dateTime: z.string().min(1).max(64),
  timeZone: z.string().min(1).max(100),
}).strict().nullable();

const bodySchema = z.object({
  content: z.string().max(20_000),
  contentType: z.enum(['text', 'html']),
}).strict().nullable();

const baseTaskSchema = z.object({
  id: z.string().min(1).max(500),
  title: z.string().min(1).max(1_000),
  status: z.enum(['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred']),
  importance: z.enum(['low', 'normal', 'high']),
  body: bodySchema.optional(),
  createdDateTime: z.string().datetime({ offset: true }),
  lastModifiedDateTime: z.string().datetime({ offset: true }),
  completedDateTime: dateTimeValueSchema.optional(),
  dueDateTime: dateTimeValueSchema.optional(),
  isReminderOn: z.boolean().nullable().optional(),
  reminderDateTime: dateTimeValueSchema.optional(),
}).strict();

export const standardPullResponseSchema = z.object({
  schemaVersion: z.literal('1.0'),
  connectorInstanceId: z.string().min(1).max(100),
  syncTimestamp: z.string().datetime({ offset: true }),
  isFullSnapshot: z.literal(true),
  lists: z.array(z.object({
    id: z.string().min(1).max(500),
    displayName: z.string().min(1).max(500),
    wellKnownListName: z.string().max(100).nullable().optional(),
    isOwner: z.boolean().nullable().optional(),
    isShared: z.boolean().nullable().optional(),
    tasks: z.array(baseTaskSchema).max(999),
  }).strict()).max(500),
}).strict();

const extendedTaskSchema = baseTaskSchema.extend({
  removed: z.literal(false),
  etag: z.string().max(500).nullable().optional(),
  bodyLastModifiedDateTime: z.string().datetime({ offset: true }).nullable().optional(),
  categories: z.array(z.string().min(1).max(255)).max(100).optional(),
  recurrence: z.record(z.string(), z.unknown()).nullable().optional(),
  checklistItems: z.array(z.object({
    id: z.string().min(1).max(500),
    displayName: z.string().min(1).max(1_000),
    isChecked: z.boolean(),
  }).strict()).max(1_000).optional(),
  linkedResources: z.array(z.object({
    id: z.string().min(1).max(500),
    applicationName: z.string().max(255),
    displayName: z.string().max(1_000),
    webUrl: z.string().max(4_000).optional(),
  }).strict()).max(100).optional(),
  attachments: z.array(z.object({
    id: z.string().min(1).max(500),
    name: z.string().min(1).max(1_000),
    contentType: z.string().max(255),
    size: z.number().int().nonnegative(),
    lastModifiedDateTime: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict()).max(100).optional(),
}).strict();

const removedTaskSchema = z.object({
  id: z.string().min(1).max(500),
  removed: z.literal(true),
}).strict();

export const extendedPullResponseSchema = z.object({
  schemaVersion: z.literal('1.1'),
  connectorInstanceId: z.string().min(1).max(100),
  syncTimestamp: z.string().datetime({ offset: true }),
  syncMode: z.literal('delta'),
  reset: z.boolean(),
  complete: z.literal(true),
  listDeltaLink: z.string().min(1).max(8_000),
  lists: z.array(z.discriminatedUnion('removed', [
    z.object({
      id: z.string().min(1).max(500),
      removed: z.literal(true),
      taskDeltaLink: z.string().max(8_000).nullable(),
      tasks: z.array(z.union([extendedTaskSchema, removedTaskSchema])).max(5_000),
    }).strict(),
    z.object({
      id: z.string().min(1).max(500),
      removed: z.literal(false),
      displayName: z.string().min(1).max(500),
      wellKnownListName: z.string().max(100).nullable().optional(),
      isOwner: z.boolean().nullable().optional(),
      isShared: z.boolean().nullable().optional(),
      taskDeltaLink: z.string().max(8_000).nullable(),
      tasks: z.array(z.union([extendedTaskSchema, removedTaskSchema])).max(5_000),
    }).strict(),
  ])).max(500),
}).strict();

export const workTodoIngestSchema = z.union([
  standardPullResponseSchema,
  extendedPullResponseSchema,
]);

export const workTodoChangesRequestSchema = z.object({
  connectorInstanceId: z.string().min(1).max(100),
  limit: z.number().int().min(1).max(100).optional(),
  leaseSeconds: z.number().int().min(30).max(1_800).optional(),
}).strict();

export const workTodoAckSchema = z.object({
  connectorInstanceId: z.string().min(1).max(100),
  leaseId: z.string().uuid(),
  processedAt: z.string().datetime({ offset: true }),
  results: z.array(z.object({
    idempotencyKey: z.string().min(8).max(200),
    sourceId: z.string().min(1).max(1_000),
    status: z.enum(['succeeded', 'failed', 'skipped']),
    errorCode: z.string().max(100).nullable().optional(),
    errorMessage: z.string().max(500).nullable().optional(),
  }).strict()).max(100),
}).strict();

export type WorkTodoIngest = z.infer<typeof workTodoIngestSchema>;
export type WorkTodoAck = z.infer<typeof workTodoAckSchema>;
