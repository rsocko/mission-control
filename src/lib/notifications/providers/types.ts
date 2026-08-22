import type {
  InboundNotification,
  NotificationActionVariant,
  NotificationLevel,
  NotificationState,
} from '@/types';

export interface NotificationActionDraft {
  actionType: string;
  label: string;
  icon?: string;
  variant: NotificationActionVariant;
  isPrimary?: boolean;
  sortOrder?: number;
  payload?: Record<string, unknown>;
  opensExternal?: boolean;
  requiresConfirmation?: boolean;
  createdBy?: 'system' | 'connector' | 'plugin' | 'ai';
}

export type NotificationPresentationTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

export interface NotificationPresentationLink {
  label: string;
  url: string;
}

export interface NotificationPresentationStat {
  label?: string;
  value: string;
  tone?: NotificationPresentationTone;
}

export interface NotificationRichContent {
  primaryText?: string;
  secondaryText?: string;
  progress?: {
    value: number;
    max: number;
    label: string;
    tone?: NotificationPresentationTone;
  };
  stats?: NotificationPresentationStat[];
  footerText?: string;
  links?: NotificationPresentationLink[];
}

export interface NotificationProviderPresentation {
  title?: string;
  body?: string | null;
  level?: NotificationLevel;
  category?: string;
  templateKey?: string | null;
  presentation?: Record<string, unknown> & {
    sourceName?: string;
    subtitle?: string;
    richContent?: NotificationRichContent;
  };
  metadata?: Record<string, unknown>;
  entityNumber?: number;
  repository?: string;
  isActionable?: boolean;
  actions?: NotificationActionDraft[];
}

export interface NotificationSignature {
  key: string;
  matches(notification: InboundNotification): boolean;
  present(notification: InboundNotification): NotificationProviderPresentation;
}

export interface StoredNotificationForAction {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body: string | null;
  category: string;
  navigationTarget: string | null;
  metadata: unknown;
  presentation: unknown;
}

export interface StoredNotificationAction {
  id: string;
  notificationId: string;
  actionType: string;
  payload: unknown;
}

export interface NotificationProviderActionContext {
  notification: StoredNotificationForAction;
  action: StoredNotificationAction;
  payload: Record<string, unknown>;
  input: Record<string, unknown>;
}

export interface NotificationProviderActionResult {
  result: Record<string, unknown>;
  state?: Extract<NotificationState, 'read' | 'resolved' | 'dismissed'>;
  error?: {
    message: string;
    status: 400 | 409 | 503;
  };
}

export interface NotificationSourceProvider {
  sourceType: string;
  displayName: string;
  signatures: readonly NotificationSignature[];
  executeAction?(
    context: NotificationProviderActionContext,
  ): Promise<NotificationProviderActionResult | null>;
}

export interface ResolvedNotificationProvider {
  provider: NotificationSourceProvider;
  signature: NotificationSignature;
  presentation: NotificationProviderPresentation;
}
