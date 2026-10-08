import type { CreateNotificationInput } from '@/db/persistence/notification-delivery';
import type { NotificationLevel, NotificationSourceState } from '@/types';
import { createNotifications } from '@/lib/notifications/service';
import {
  companionActionV2Digest,
  type CompanionActionFeedPageV2,
} from './action-contract-v2';
import type { ActionV2 } from './action-contract';
import {
  resolveRyMessageSemanticType,
  ryMessageNotificationCategory,
  ryMessageNotificationLevel,
} from './notification-semantics';

interface NotificationProjection {
  connectorId: string;
  actionId: string;
  sourceId: string;
  revision: number;
  action: ActionV2 | null;
  tombstonedAt: string | null;
}

function notificationSourceId(connectorId: string, actionId: string): string {
  return `rymessage:companion:${connectorId}:${actionId}`;
}

function notificationLevel(
  projection: NotificationProjection,
): NotificationLevel {
  const action = projection.action;
  return ryMessageNotificationLevel({
    priority: action?.content.priority,
    semanticType: resolveRyMessageSemanticType(
      action?.content.category,
      action?.content.actionType,
    ),
    confidenceClass: action?.classification.confidenceClass,
  });
}

function sourceState(projection: NotificationProjection): NotificationSourceState {
  if (projection.tombstonedAt || !projection.action) return 'deleted';
  return ['dismissed', 'handled', 'completed'].includes(projection.action.lifecycle.state)
    ? 'resolved'
    : 'active';
}

function projectionInput(
  connectorId: string,
  projection: NotificationProjection,
): CreateNotificationInput {
  const action = projection.action;
  const lifecycle = action?.lifecycle.state ?? 'completed';
  const receivedAt = action?.createdAt ?? projection.tombstonedAt ?? new Date().toISOString();
  const updatedAt = action?.updatedAt ?? projection.tombstonedAt ?? receivedAt;
  const semanticType = resolveRyMessageSemanticType(
    action?.content.category,
    action?.content.actionType,
  );
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
    category: ryMessageNotificationCategory(semanticType),
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
      contract: 'companion-action-v2',
      actionId: projection.actionId,
      revision: projection.revision,
      lifecycleRevision: action?.fieldRevisions.lifecycle ?? projection.revision,
      actionType: action?.content.actionType,
      category: action?.content.category,
      semanticType,
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
      sourceKind: action?.source.sourceKind,
      sourceFamily: action?.source.sourceFamily,
      tombstoned: Boolean(projection.tombstonedAt),
    },
    enrichmentRevision: `rymessage:${projection.revision}:${lifecycle}`,
  };
}

export async function projectCompanionActionV2PageToNotifications(
  connectorId: string,
  page: CompanionActionFeedPageV2,
  signal?: AbortSignal,
): Promise<{ created: number; updated: number }> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('RyMessage sync aborted', 'AbortError');
  }
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
      action: projection.action,
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
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('RyMessage sync aborted', 'AbortError');
  }
  const results = await createNotifications(inputs);
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('RyMessage sync aborted', 'AbortError');
  }
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
