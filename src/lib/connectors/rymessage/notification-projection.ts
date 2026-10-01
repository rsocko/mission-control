import type {
  RyMessageActionPersistence,
  RyMessageActionProjection,
} from '@/db/persistence/rymessage-actions';
import type { CreateNotificationInput } from '@/db/persistence/notification-delivery';
import type { NotificationLevel, NotificationSourceState } from '@/types';
import { createNotifications } from '@/lib/notifications/service';
import {
  companionActionV2Digest,
  type CompanionActionFeedPageV2,
} from './action-contract-v2';
import {
  sanitizeCompanionAction,
  type CompanionActionV1,
  type PortableCompanionAction,
} from './action-contract';

function portableAction(
  action: CompanionActionV1 | PortableCompanionAction,
): PortableCompanionAction {
  return 'materializations' in action ? sanitizeCompanionAction(action) : action;
}

function notificationSourceId(connectorId: string, actionId: string): string {
  return `rymessage:companion:${connectorId}:${actionId}`;
}

function notificationLevel(
  projection: RyMessageActionProjection,
): NotificationLevel {
  const action = projection.action;
  const priority = action?.content.priority ?? 'none';
  const confidence = action?.classification.confidenceClass;
  if (priority === 'critical') return 'urgent';
  if (priority === 'high') return confidence === 'low' ? 'heads_up' : 'action_needed';
  if (priority === 'medium') return confidence === 'high' ? 'action_needed' : 'heads_up';
  return confidence === 'high' ? 'heads_up' : 'fyi';
}

function notificationCategory(category: string | undefined): string {
  if (!category) return 'social';
  if (category === 'security') return 'security';
  if (category === 'automation') return 'automation';
  if (category === 'development') return 'development';
  return 'social';
}

function sourceState(projection: RyMessageActionProjection): NotificationSourceState {
  if (projection.tombstonedAt || !projection.action) return 'deleted';
  return ['dismissed', 'handled', 'completed'].includes(projection.action.lifecycle.state)
    ? 'resolved'
    : 'active';
}

function projectionInput(
  connectorId: string,
  projection: RyMessageActionProjection,
): CreateNotificationInput {
  const action = projection.action;
  const lifecycle = action?.lifecycle.state ?? 'completed';
  const receivedAt = action?.createdAt ?? projection.tombstonedAt ?? new Date().toISOString();
  const updatedAt = action?.updatedAt ?? projection.tombstonedAt ?? receivedAt;
  const body = action?.source?.messageExcerpt
    ?? action?.content.summary
    ?? action?.content.details
    ?? action?.classification.reason
    ?? null;
  return {
    sourceId: notificationSourceId(connectorId, projection.actionId),
    connectorType: 'rymessage',
    connectorInstanceId: connectorId,
    title: action?.content.title ?? 'RyMessage action removed',
    body,
    level: notificationLevel(projection),
    category: notificationCategory(action?.content.category),
    templateKey: 'rymessage.companion-action',
    sourceState: sourceState(projection),
    sourceActivityAt: updatedAt,
    sourceActivityKey: `${projection.revision}:${lifecycle}:${projection.tombstonedAt ?? 'live'}`,
    reopenPolicy: 'never',
    receivedAt,
    sortAt: updatedAt,
    relatedEntityType: 'rymessage-action',
    relatedEntityId: projection.actionId,
    isActionable: Boolean(action && lifecycle !== 'completed'),
    metadata: {
      contract: 'companion-action-v1',
      actionId: projection.actionId,
      revision: projection.revision,
      lifecycleRevision: action?.fieldRevisions.lifecycle ?? projection.revision,
      actionType: action?.content.actionType,
      category: action?.content.category,
      direction: action?.content.direction,
      recommendation: action?.content.recommendation,
      priority: action?.content.priority ?? 'none',
      details: action?.content.details,
      senderDisplayName: action?.source?.senderDisplayName,
      conversationTitle: action?.source?.conversationTitle,
      messageExcerpt: action?.source?.messageExcerpt,
      sourceUrl: action?.source?.sourceUrl,
      sourceCreatedAt: action?.source?.sourceCreatedAt,
      confidenceClass: action?.classification.confidenceClass,
      confidenceScore: action?.classification.confidenceScore,
      classificationReason: action?.classification.reason,
      derivationMethod: action?.classification.derivationMethod,
      classificationModel: action?.classification.model,
      derivationVersion: action?.classification.derivationVersion,
      lifecycle,
      snoozedUntil: action?.lifecycle.snoozedUntil,
      dismissedAt: action?.lifecycle.dismissedAt,
      dismissedReason: action?.lifecycle.dismissedReason,
      handledAt: action?.lifecycle.handledAt,
      correction: action?.lifecycle.correction,
      actionCreatedAt: action?.createdAt,
      actionUpdatedAt: action?.updatedAt,
      lastSeenAt: action?.lastSeenAt,
      sourceKind: action?.sourceKind,
      sourceFamily: action?.sourceFamily,
      tombstoned: Boolean(projection.tombstonedAt),
    },
    enrichmentRevision: `rymessage:${projection.revision}:${lifecycle}`,
  };
}

export async function projectCompanionActionsToNotifications(
  connectorId: string,
  repository: RyMessageActionPersistence,
): Promise<{ created: number; updated: number }> {
  const projections = await repository.listProjections(connectorId);
  if (projections.length === 0) return { created: 0, updated: 0 };
  const results = await createNotifications(
    projections.map((projection) => projectionInput(connectorId, projection)),
  );
  return {
    created: results.filter((result) => result.created).length,
    updated: results.filter((result) => !result.created).length,
  };
}

export async function projectCompanionActionV2PageToNotifications(
  connectorId: string,
  page: CompanionActionFeedPageV2,
): Promise<{ created: number; updated: number }> {
  if (page.items.length === 0) return { created: 0, updated: 0 };
  const inputs = page.items.map((item) => {
    if (item.kind === 'tombstone') {
      return projectionInput(connectorId, {
        connectorId,
        actionId: item.aggregateId,
        revision: item.aggregateVersion,
        sourceId: item.sourceId,
        action: null,
        tombstonedAt: item.occurredAt,
      });
    }
    const { projection } = item;
    const relations = projection.taskMaterializations.filter(
      relation => relation.state !== 'unlinked',
    );
    const activeRelations = relations.filter(relation => (
      relation.state === 'link-broken'
      || relation.snapshot.availability !== 'live'
      || !['completed', 'cancelled', 'deleted'].includes(relation.snapshot.status)
    ));
    const base = projectionInput(connectorId, {
      connectorId,
      actionId: item.aggregateId,
      revision: item.aggregateVersion,
      sourceId: item.sourceId,
      action: portableAction(projection.action),
      tombstonedAt: null,
    });
    const presentationDigest = companionActionV2Digest({
      action: projection.action,
      taskMaterializations: relations,
      taskLifecycle: projection.taskLifecycle,
    });
    return {
      ...base,
      sourceActivityKey: [
        base.sourceActivityKey,
        presentationDigest,
        projection.taskLifecycle.provenance,
        projection.taskLifecycle.state,
        ...relations.map(relation => `${relation.relationId}:${relation.revision}`),
      ].join(':'),
      metadata: {
        ...base.metadata,
        contract: 'companion-action-v2',
        linkedTaskCount: relations.length,
        linkedRelationIds: relations.map(relation => relation.relationId),
        activeLinkedTaskCount: activeRelations.length,
        terminalLinkedTaskCount: relations.length - activeRelations.length,
        taskLifecycleSource: projection.taskLifecycle.provenance,
        taskLifecycleState: projection.taskLifecycle.state,
        taskMaterializations: relations.map(relation => ({
          relationId: relation.relationId,
          revision: relation.revision,
          state: relation.state,
          providerLabel: relation.snapshot.providerLabel,
          providerIconKey: relation.snapshot.providerIconKey,
          title: relation.snapshot.title,
          status: relation.snapshot.status,
          availability: relation.snapshot.availability,
          observedAt: relation.snapshot.observedAt,
          openUrl: relation.snapshot.openUrl,
          managedByMissionControl: relation.management?.manager === 'mission-control',
          managerTaskId: relation.management?.managerTaskId,
        })),
      },
      enrichmentRevision: `rymessage-v2:${item.aggregateVersion}:${presentationDigest}`,
    };
  });
  const results = await createNotifications(inputs);
  return {
    created: results.filter(result => result.created).length,
    updated: results.filter(result => !result.created).length,
  };
}

export const rymessageNotificationProjection = {
  notificationSourceId,
  notificationLevel,
  sourceState,
  projectionInput,
};
