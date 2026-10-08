import { normalizeNotificationUrl } from './registry';
import type {
  NotificationActionDraft,
  NotificationPresentationTone,
  NotificationSourceProvider,
} from './types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function humanizeIdentifier(value: string): string {
  const words = value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words
    ? words.replace(/\b\w/g, character => character.toUpperCase())
    : value;
}

function approvalSubject(value: string): string {
  const normalized = value
    .replace(/^request_/, '')
    .replace(/^approve_/, '')
    .replace(/_approval$/, '');
  const subject = humanizeIdentifier(normalized || value);
  return `${subject} approval`;
}

function absoluteDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw || !Number.isFinite(Date.parse(raw))) return undefined;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(raw));
}

function riskTone(value: string | undefined): NotificationPresentationTone {
  if (value === 'critical' || value === 'high') return 'danger';
  if (value === 'medium') return 'warning';
  if (value === 'low') return 'success';
  return 'neutral';
}

function openAction(url: string | null): NotificationActionDraft[] {
  return url ? [{
    actionType: 'open_url',
    label: 'Review in Paperclip',
    icon: 'external-link',
    variant: 'secondary',
    payload: { url },
    opensExternal: true,
    createdBy: 'connector',
  }] : [];
}

function approvalPresentation(notification: Parameters<NotificationSourceProvider['signatures'][number]['present']>[0]) {
  const metadata = record(notification.metadata);
  const approvalType = text(metadata.approvalType) || 'approval';
  const subject = approvalSubject(approvalType);
  const company = text(metadata.companyName) || text(metadata.companyId);
  const requester = text(metadata.requester);
  const risk = text(metadata.risk);
  const issueId = text(metadata.issueId);
  const summary = text(metadata.summary);
  const expiresAt = absoluteDate(metadata.expiresAt);
  const actionUrl = normalizeNotificationUrl(notification.actionUrl);
  const actions: NotificationActionDraft[] = [
    {
      actionType: 'paperclip_approve',
      label: 'Approve',
      icon: 'check-circle',
      variant: 'primary',
      isPrimary: true,
      requiresConfirmation: true,
      createdBy: 'connector',
    },
    {
      actionType: 'paperclip_reject',
      label: 'Reject',
      icon: 'x-circle',
      variant: 'danger',
      requiresConfirmation: true,
      createdBy: 'connector',
    },
    ...openAction(actionUrl),
  ];

  return {
    title: `${subject} requested`,
    body: null,
    presentation: {
      sourceName: 'Paperclip',
      subtitle: [company, 'Pending approval'].filter(Boolean).join(' · '),
      metadataChips: [
        ...(issueId ? [{ label: 'Issue', value: issueId }] : []),
        ...(requester ? [{ label: 'Requested by', value: requester }] : []),
      ],
      richContent: {
        ...(summary ? { primaryText: summary } : {}),
        stats: [
          { label: 'Type', value: subject },
          {
            label: 'Risk',
            value: risk && risk !== 'Not specified' ? humanizeIdentifier(risk) : 'Not specified',
            tone: riskTone(risk?.toLowerCase()),
          },
        ],
        footerText: expiresAt
          ? `Decision requested before ${expiresAt}.`
          : 'Paperclip remains the authoritative approval source.',
      },
      providerSignature: 'paperclip-approval-v2',
    },
    actions,
    isActionable: actions.length > 0,
  };
}

function attentionPresentation(notification: Parameters<NotificationSourceProvider['signatures'][number]['present']>[0]) {
  const metadata = record(notification.metadata);
  const sourceKind = text(metadata.sourceKind);
  const detailKind = text(metadata.detailKind);
  const company = text(metadata.companyName) || text(metadata.companyId);
  const issueId = text(metadata.identifier) || text(metadata.issueId);
  const summary = text(metadata.summary);
  const whyNow = text(metadata.whyNow);
  const decisions = Array.isArray(metadata.decisionLabels)
    ? metadata.decisionLabels.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  const actionUrl = normalizeNotificationUrl(notification.actionUrl);

  return {
    body: null,
    presentation: {
      sourceName: 'Paperclip',
      subtitle: [
        company,
        sourceKind ? humanizeIdentifier(sourceKind) : undefined,
      ].filter(Boolean).join(' · '),
      metadataChips: [
        ...(issueId ? [{ label: 'Issue', value: issueId }] : []),
        ...(detailKind && detailKind !== 'generic'
          ? [{ label: 'Detail', value: humanizeIdentifier(detailKind) }]
          : []),
      ],
      richContent: {
        ...(summary ? { primaryText: summary } : {}),
        ...(whyNow ? { secondaryText: whyNow } : {}),
        ...(decisions.length ? {
          stats: [{
            label: 'Decisions',
            value: decisions.map(humanizeIdentifier).join(' · '),
            tone: 'info' as const,
          }],
        } : {}),
        footerText: 'Open Paperclip to review the authoritative context.',
      },
      providerSignature: 'paperclip-attention-v2',
    },
    actions: openAction(actionUrl),
    isActionable: Boolean(actionUrl),
  };
}

export const paperclipNotificationProvider: NotificationSourceProvider = {
  sourceType: 'paperclip',
  displayName: 'Paperclip',
  signatures: [
    {
      key: 'paperclip-approval-v2',
      matches: notification => notification.templateKey === 'paperclip_approval',
      present: approvalPresentation,
    },
    {
      key: 'paperclip-attention-v2',
      matches: notification => notification.templateKey === 'paperclip_attention',
      present: attentionPresentation,
    },
  ],
};
