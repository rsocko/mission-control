import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import {
  DURABLE_AI_ENQUEUEABLE_ROUTES,
} from '@/lib/ai/durable-runs/route-contract';
import {
  SEMANTIC_SOURCE_ENTITY_TYPES,
} from '@/lib/semantic-index/source/contracts';

export const POSTGRES_PACKAGED_WORKFLOW_FAMILIES = Object.freeze([
  'durable-ai',
  'event-outbox',
  'notification-enrichment',
  'planning-signals',
  'project-automation',
  'semantic-search',
] as const);

export type PostgresPackagedWorkflowFamily =
  (typeof POSTGRES_PACKAGED_WORKFLOW_FAMILIES)[number];

const REQUIRED_SEMANTIC_INTENTS = ['upsert', 'delete'] as const;
const CAPABILITY_ID = Symbol('postgres-packaged-workflow-capability');
const REQUIRED_REPOSITORY_METHODS = {
  planningSignals: ['append', 'finalize', 'finalizeIfDue'],
  projectAutomation: ['evaluateAll', 'evaluateProject', 'previewProject', 'evaluateTasks'],
  eventSubscriptions: ['listMatching', 'recordDeliveryOutcome'],
  eventOutbox: [
    'enqueue',
    'claimNext',
    'heartbeat',
    'markDelivered',
    'scheduleRetry',
    'deadLetter',
    'recoverStaleLeases',
    'getNextWakeAt',
  ],
  notificationEnrichment: [
    'claimNext',
    'heartbeat',
    'complete',
    'scheduleRetry',
    'deadLetter',
    'recoverStaleLeases',
    'getNextWakeAt',
  ],
} as const;

export interface PostgresPackagedWorkflowCapability {
  readonly id: typeof CAPABILITY_ID;
  readonly workflows: readonly PostgresPackagedWorkflowFamily[];
}

function sameMembers(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

function hasMethods(
  value: unknown,
  methods: readonly string[],
): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && methods.every((method) => (
      typeof (value as Record<string, unknown>)[method] === 'function'
    )),
  );
}

export function composePostgresPackagedWorkflowCapability(input: {
  persistence: WorkerPersistenceRepositories;
  durableExecutorRoutes: readonly string[];
  semanticEntityTypes: readonly string[];
  semanticIntentKinds: readonly string[];
  lifecycleStops: Readonly<Record<
    PostgresPackagedWorkflowFamily,
    () => void | Promise<void>
  >>;
}): PostgresPackagedWorkflowCapability {
  const { persistence } = input;
  const completeRepositories = (
    hasMethods(
      persistence.planningSignals,
      REQUIRED_REPOSITORY_METHODS.planningSignals,
    )
    && hasMethods(
      persistence.projectAutomation,
      REQUIRED_REPOSITORY_METHODS.projectAutomation,
    )
    && hasMethods(
      persistence.eventDelivery?.subscriptions,
      REQUIRED_REPOSITORY_METHODS.eventSubscriptions,
    )
    && hasMethods(
      persistence.eventDelivery?.outbox,
      REQUIRED_REPOSITORY_METHODS.eventOutbox,
    )
    && hasMethods(
      persistence.notificationEnrichment,
      REQUIRED_REPOSITORY_METHODS.notificationEnrichment,
    )
  );
  if (!completeRepositories) {
    throw new Error('PostgreSQL packaged workflow repositories are incomplete');
  }
  if (!sameMembers(input.durableExecutorRoutes, DURABLE_AI_ENQUEUEABLE_ROUTES)) {
    throw new Error('PostgreSQL durable AI executor route coverage is incomplete');
  }
  if (!sameMembers(input.semanticEntityTypes, SEMANTIC_SOURCE_ENTITY_TYPES)) {
    throw new Error('PostgreSQL semantic entity coverage is incomplete');
  }
  if (!sameMembers(input.semanticIntentKinds, REQUIRED_SEMANTIC_INTENTS)) {
    throw new Error('PostgreSQL semantic intent coverage is incomplete');
  }
  if (!sameMembers(
    Object.keys(input.lifecycleStops),
    POSTGRES_PACKAGED_WORKFLOW_FAMILIES,
  ) || POSTGRES_PACKAGED_WORKFLOW_FAMILIES.some(
    (family) => typeof input.lifecycleStops[family] !== 'function',
  )) {
    throw new Error('PostgreSQL packaged workflow cleanup coverage is incomplete');
  }
  return Object.freeze({
    id: CAPABILITY_ID,
    workflows: POSTGRES_PACKAGED_WORKFLOW_FAMILIES,
  });
}

export function isPostgresBackendWorkflowSupported(
  workflow: string,
): boolean {
  return POSTGRES_PACKAGED_WORKFLOW_FAMILIES.includes(
    workflow as PostgresPackagedWorkflowFamily,
  );
}

export class PostgresWorkerProcessingLatch {
  private active = false;
  private activated = false;
  private readonly activationListeners: Array<() => void> = [];

  isActive = (): boolean => this.active;

  onActivate(listener: () => void): void {
    if (this.activated) {
      throw new Error('PostgreSQL worker processing latch is already activated');
    }
    this.activationListeners.push(listener);
  }

  activate(capability: PostgresPackagedWorkflowCapability): void {
    if (capability.id !== CAPABILITY_ID || this.activated) {
      throw new Error('PostgreSQL packaged workflow capability activation is invalid');
    }
    this.activated = true;
    this.active = true;
    try {
      for (const listener of this.activationListeners) listener();
    } catch (error) {
      this.active = false;
      throw error;
    }
  }

  deactivate(capability: PostgresPackagedWorkflowCapability): void {
    if (capability.id === CAPABILITY_ID) this.active = false;
  }
}
