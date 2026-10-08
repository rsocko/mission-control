'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  Check,
  ChevronDown,
  Loader2,
  RotateCcw,
  Save,
  ShieldAlert,
  Smartphone,
} from 'lucide-react';
import { ConnectorBrandIcon } from '@/app/settings/components/ConnectorBrandIcon';
import { SectionCard, SectionLabel, Toggle } from '@/components/settings/SettingsPrimitives';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePushNotifications } from '@/lib/hooks/usePushNotifications';
import { cn } from '@/lib/utils';
import type { NotificationPushRule } from '@/db/persistence/notification-delivery';
import {
  isPushPreview,
  type PushPreview,
} from '@/lib/notifications/push-policy/catalog';
import { isNotificationLevel } from '@/lib/notifications/levels';
import type {
  ConnectorPushRuleGroup,
  ConnectorPushRuleType,
  EffectivePushRule,
  PushRulesResponse,
  SavePushRuleRequest,
} from '@/lib/notifications/push-rules-contract';
import type { NotificationLevel } from '@/types';

const LEVEL_OPTIONS: Array<{ value: NotificationLevel; label: string }> = [
  { value: 'urgent', label: 'Urgent only' },
  { value: 'action_needed', label: 'Action Needed+' },
  { value: 'heads_up', label: 'Heads Up+' },
  { value: 'fyi', label: 'FYI+' },
  { value: 'digest', label: 'All levels' },
];

interface RuleDraft {
  enabled: boolean;
  minLevel: NotificationLevel;
  preview: PushPreview;
  maxPerHour: string;
}

interface RuleEditorProps {
  connector: ConnectorPushRuleGroup;
  label: string;
  description: string;
  templateKey: string;
  effective: EffectivePushRule;
  override: NotificationPushRule | null;
  sensitive: boolean;
  wildcardHasSensitiveTypes?: boolean;
  disabled: boolean;
  onSaved: () => Promise<void>;
}

async function fetchPushRules(): Promise<PushRulesResponse> {
  const response = await fetch('/api/push/rules');
  if (!response.ok) throw new Error('Connector push rules could not be loaded.');
  const body = await response.json() as unknown;
  if (
    !body
    || typeof body !== 'object'
    || !('global' in body)
    || !('connectors' in body)
    || !Array.isArray(body.connectors)
    || !body.global
    || typeof body.global !== 'object'
  ) {
    throw new Error('Connector push rules returned an invalid response.');
  }
  return body as PushRulesResponse;
}

function draftFromRule(
  effective: EffectivePushRule,
  override: NotificationPushRule | null,
): RuleDraft {
  const values = override ?? effective;
  return {
    enabled: values.enabled,
    minLevel: values.minLevel,
    preview: values.preview,
    maxPerHour: values.maxPerHour === null ? '' : String(values.maxPerHour),
  };
}

function sourceLabel(
  effective: EffectivePushRule,
  override: NotificationPushRule | null,
): string {
  if (override) return 'Custom';
  if (effective.sourceDetail === 'wildcard') return 'Connector override';
  if (effective.sourceDetail === 'recommended') return 'Recommended';
  return 'System default';
}

function RuleEditor({
  connector,
  label,
  description,
  templateKey,
  effective,
  override,
  sensitive,
  wildcardHasSensitiveTypes = false,
  disabled,
  onSaved,
}: RuleEditorProps) {
  const [draft, setDraft] = useState(() => draftFromRule(effective, override));
  const [busyAction, setBusyAction] = useState<'save' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bodyPreviewUnsafe = sensitive || wildcardHasSensitiveTypes;
  const maxPerHour = draft.maxPerHour.trim() === ''
    ? null
    : Number(draft.maxPerHour);
  const rateLimitValid = maxPerHour === null
    || (Number.isInteger(maxPerHour) && maxPerHour >= 1 && maxPerHour <= 1_000);
  const changed = (
    draft.enabled !== (override ?? effective).enabled
    || draft.minLevel !== (override ?? effective).minLevel
    || draft.preview !== (override ?? effective).preview
    || maxPerHour !== (override ?? effective).maxPerHour
  );

  const save = async () => {
    if (!rateLimitValid || busyAction) return;
    setBusyAction('save');
    setError(null);
    const input: SavePushRuleRequest = {
      connectorInstanceId: connector.connectorInstanceId,
      templateKey,
      enabled: draft.enabled,
      minLevel: draft.minLevel,
      preview: draft.preview,
      maxPerHour,
    };
    try {
      const response = await fetch('/api/push/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(
          typeof body?.error === 'string' ? body.error : 'The rule could not be saved.',
        );
      }
      await onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The rule could not be saved.');
    } finally {
      setBusyAction(null);
    }
  };

  const reset = async () => {
    if (!override || busyAction) return;
    setBusyAction('reset');
    setError(null);
    const params = new URLSearchParams({
      connectorInstanceId: connector.connectorInstanceId,
      templateKey,
    });
    try {
      const response = await fetch(`/api/push/rules?${params}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(
          typeof body?.error === 'string' ? body.error : 'The rule could not be reset.',
        );
      }
      await onSaved();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'The rule could not be reset.');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <fieldset
      disabled={disabled || busyAction !== null}
      className="border-t border-[var(--border-subtle)] px-4 py-3.5 disabled:opacity-60"
    >
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
            <span className={cn(
              'rounded-full border px-2 py-0.5 text-xs font-medium',
              override
                ? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
                : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-tertiary)]',
            )}>
              {sourceLabel(effective, override)}
            </span>
          </div>
          <p className="mt-1 max-w-[65ch] text-xs leading-5 text-[var(--text-tertiary)]">
            {description}
          </p>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-[auto_9rem_9rem_7rem_auto]">
          <div className="flex min-h-9 items-center gap-2 sm:px-1">
            <span className="text-xs text-[var(--text-tertiary)]">
              {draft.enabled ? 'On' : 'Off'}
            </span>
            <Toggle
              enabled={draft.enabled}
              onChange={enabled => setDraft(current => ({ ...current, enabled }))}
              label={`${label} push delivery`}
            />
          </div>
          <Select
            value={draft.minLevel}
            onValueChange={value => {
              if (isNotificationLevel(value)) {
                setDraft(current => ({ ...current, minLevel: value }));
              }
            }}
          >
            <SelectTrigger aria-label={`${label} minimum level`} className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVEL_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={draft.preview}
            onValueChange={value => {
              if (isPushPreview(value)) {
                setDraft(current => ({ ...current, preview: value }));
              }
            }}
          >
            <SelectTrigger aria-label={`${label} lock-screen preview`} className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="title_only">Title only</SelectItem>
              <SelectItem value="title_and_body" disabled={bodyPreviewUnsafe}>
                Title and body
              </SelectItem>
            </SelectContent>
          </Select>
          <label className={cn(
            'input-glow relative h-9 rounded-lg border bg-[var(--surface-0)]',
            rateLimitValid
              ? 'border-[var(--border)]'
              : 'border-red-500 focus-within:border-red-500 focus-within:ring-2 focus-within:ring-red-500/20',
          )}>
            <span className="sr-only">{label} hourly limit</span>
            <input
              type="number"
              min={1}
              max={1_000}
              inputMode="numeric"
              value={draft.maxPerHour}
              onChange={event => setDraft(current => ({
                ...current,
                maxPerHour: event.target.value,
              }))}
              placeholder="No limit"
              aria-invalid={!rateLimitValid}
              className="h-full w-full rounded-lg border-0 bg-transparent px-2 text-xs text-[var(--text-primary)] outline-none"
            />
          </label>
          <div className="col-span-2 flex justify-end gap-1 sm:col-span-1">
            {override && (
              <button
                type="button"
                onClick={reset}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {busyAction === 'reset'
                  ? <Loader2 size={13} className="animate-spin" />
                  : <RotateCcw size={13} />}
                Reset
              </button>
            )}
            <button
              type="button"
              onClick={save}
              disabled={!changed || !rateLimitValid}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              {busyAction === 'save'
                ? <Loader2 size={13} className="animate-spin" />
                : override && !changed
                  ? <Check size={13} />
                  : <Save size={13} />}
              Save
            </button>
          </div>
        </div>
      </div>
      {!rateLimitValid && (
        <p className="mt-2 text-xs text-red-400" role="alert">
          Hourly limit must be between 1 and 1,000, or left blank.
        </p>
      )}
      {bodyPreviewUnsafe && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          Body previews are unavailable because this rule includes sensitive notifications.
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-400" role="alert">
          {error} Check the values and try again.
        </p>
      )}
    </fieldset>
  );
}

function wildcardEffective(connector: ConnectorPushRuleGroup): EffectivePushRule {
  const override = connector.wildcardOverride;
  return {
    enabled: override?.enabled ?? false,
    minLevel: override?.minLevel ?? 'urgent',
    preview: override?.preview ?? 'title_only',
    maxPerHour: override?.maxPerHour ?? null,
    source: override ? 'user' : 'system',
    sourceDetail: override ? 'wildcard' : 'system_off',
  };
}

function ConnectorRuleGroup({
  connector,
  onReload,
}: {
  connector: ConnectorPushRuleGroup;
  onReload: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(true);
  const unavailableReason = connector.deletedAt
    ? 'Deleted connectors keep their rules for recovery, but cannot be edited or deliver push.'
    : !connector.enabled
      ? 'This connector is paused. Its rules remain editable, but delivery stays suppressed.'
      : null;
  const disabled = connector.deletedAt !== null;

  return (
    <section aria-labelledby={`push-rules-${connector.connectorInstanceId}`}>
      <button
        type="button"
        onClick={() => setExpanded(current => !current)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)]">
          <ConnectorBrandIcon type={connector.connectorType} size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            id={`push-rules-${connector.connectorInstanceId}`}
            className="block truncate text-sm font-medium text-[var(--text-primary)]"
          >
            {connector.connectorName}
          </span>
          <span className="block text-xs text-[var(--text-tertiary)]">
            {connector.notificationTypes.length} eligible notification
            {connector.notificationTypes.length === 1 ? ' type' : ' types'}
          </span>
        </span>
        {unavailableReason && (
          <span className="hidden items-center gap-1 text-xs text-amber-300 sm:flex">
            <AlertTriangle size={12} />
            {connector.deletedAt ? 'Deleted' : 'Paused'}
          </span>
        )}
        <ChevronDown
          size={15}
          className={cn(
            'text-[var(--text-muted)] transition-transform duration-150',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded && (
        <div>
          {unavailableReason && (
            <div className="border-t border-[var(--border-subtle)] bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200">
              {unavailableReason}
            </div>
          )}
          <RuleEditor
            key={`wildcard:${connector.wildcardOverride?.updatedAt ?? 'inherited'}`}
            connector={connector}
            label={`All ${connector.connectorName} notifications`}
            description="Set a fallback for every eligible type. Type-specific rules below take precedence."
            templateKey="*"
            effective={wildcardEffective(connector)}
            override={connector.wildcardOverride}
            sensitive={false}
            wildcardHasSensitiveTypes={connector.notificationTypes.some(
              item => item.definition.sensitivity === 'sensitive',
            )}
            disabled={disabled}
            onSaved={onReload}
          />
          {connector.notificationTypes.map((item: ConnectorPushRuleType) => (
            <RuleEditor
              key={[
                item.definition.key,
                item.override?.updatedAt ?? 'inherited',
                item.effective.enabled,
                item.effective.minLevel,
                item.effective.preview,
                item.effective.maxPerHour ?? 'none',
                item.effective.sourceDetail,
              ].join(':')}
              connector={connector}
              label={item.definition.label}
              description={item.definition.description}
              templateKey={item.definition.key}
              effective={item.effective}
              override={item.override}
              sensitive={item.definition.sensitivity === 'sensitive'}
              disabled={disabled}
              onSaved={onReload}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ConnectorPushRules({
  connectorInstanceId,
}: {
  connectorInstanceId?: string;
}) {
  const [data, setData] = useState<PushRulesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const push = usePushNotifications();

  const load = useCallback(async () => {
    try {
      setData(await fetchPushRules());
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Connector push rules could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetchPushRules()
      .then(body => {
        if (active) setData(body);
      })
      .catch(loadError => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Connector push rules could not be loaded.',
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const connectors = useMemo(() => {
    if (!data) return [];
    return connectorInstanceId
      ? data.connectors.filter(connector => connector.connectorInstanceId === connectorInstanceId)
      : data.connectors;
  }, [connectorInstanceId, data]);

  const enableBrowserPush = async () => {
    const subscribed = await push.subscribe();
    if (subscribed) await load();
  };

  const retry = () => {
    setLoading(true);
    setError(null);
    void load();
  };

  return (
    <div>
      {!connectorInstanceId && <SectionLabel>Connector Push Rules</SectionLabel>}
      <SectionCard>
        {!connectorInstanceId && (
          <div className="flex items-start gap-3 px-4 py-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-300">
              <BellRing size={16} />
            </span>
            <div>
              <h3 className="text-sm font-medium text-[var(--text-primary)]">
                Choose which connector events can interrupt you
              </h3>
              <p className="mt-1 max-w-[70ch] text-xs leading-5 text-[var(--text-tertiary)]">
                Rules control push delivery only. Every notification remains available in
                Mission Control, and global delivery, Do Not Disturb, and quiet hours always win.
              </p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="space-y-3 border-t border-[var(--border-subtle)] px-4 py-5" aria-label="Loading connector push rules">
            {[0, 1].map(index => (
              <div key={index} className="h-10 animate-pulse rounded-lg bg-[var(--surface-2)]" />
            ))}
          </div>
        ) : error ? (
          <div className="flex items-center justify-between gap-4 border-t border-[var(--border-subtle)] px-4 py-5">
            <div className="flex items-center gap-2 text-sm text-red-300" role="alert">
              <ShieldAlert size={16} />
              {error}
            </div>
            <button
              type="button"
              onClick={retry}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Retry
            </button>
          </div>
        ) : data ? (
          <>
            {!data.global.channelConfigured && (
              <div className="flex items-start gap-2 border-t border-[var(--border-subtle)] bg-amber-500/5 px-4 py-3 text-xs text-amber-200">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                Web Push is not configured on this server. You can prepare rules now, but
                delivery will remain unavailable until VAPID keys are configured.
              </div>
            )}
            {data.global.channelConfigured && !data.global.pushDeliveryEnabled && (
              <div className="flex items-start gap-2 border-t border-[var(--border-subtle)] bg-amber-500/5 px-4 py-3 text-xs text-amber-200">
                <BellRing size={14} className="mt-0.5 shrink-0" />
                Global Push Delivery is off. These rules are saved, but no connector push
                will be delivered until it is enabled above.
              </div>
            )}
            {data.global.channelConfigured && data.global.doNotDisturb && (
              <div className="flex items-start gap-2 border-t border-[var(--border-subtle)] bg-amber-500/5 px-4 py-3 text-xs text-amber-200">
                <BellRing size={14} className="mt-0.5 shrink-0" />
                Do Not Disturb is active and currently suppresses every connector push.
              </div>
            )}
            {data.global.channelConfigured && data.global.subscriptionCount === 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-blue-500/5 px-4 py-3">
                <div className="flex items-start gap-2 text-xs text-blue-200">
                  <Smartphone size={14} className="mt-0.5 shrink-0" />
                  Configure rules now, then enable browser notifications on this device.
                </div>
                <button
                  type="button"
                  onClick={() => void enableBrowserPush()}
                  disabled={
                    push.isLoading
                    || push.permission === 'denied'
                    || push.permission === 'unsupported'
                  }
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  {push.isLoading && <Loader2 size={12} className="animate-spin" />}
                  {push.permission === 'denied'
                    ? 'Blocked in browser'
                    : push.permission === 'unsupported'
                      ? 'Unsupported'
                      : 'Enable browser push'}
                </button>
              </div>
            )}
            {connectors.length === 0 ? (
              <div className="border-t border-[var(--border-subtle)] px-4 py-6 text-center">
                <BellRing size={22} className="mx-auto text-[var(--text-muted)]" />
                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                  No eligible notification types
                </p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {connectorInstanceId
                    ? 'This connector does not publish configurable push notifications.'
                    : 'Connect a source with a reviewed notification catalog to configure rules.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)] border-t border-[var(--border-subtle)]">
                {connectors.map(connector => (
                  <ConnectorRuleGroup
                    key={connector.connectorInstanceId}
                    connector={connector}
                    onReload={load}
                  />
                ))}
              </div>
            )}
          </>
        ) : null}
      </SectionCard>
    </div>
  );
}
