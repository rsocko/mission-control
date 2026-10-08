'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { HardDrive, Lock, ShieldCheck } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  connectorBaselineClassification,
  connectorClassificationOptions,
  DATA_CLASSIFICATION_DESCRIPTIONS,
  DATA_CLASSIFICATION_LABELS,
  type ConnectorDataClassification,
} from '@/lib/connectors/data-classification';
import type { ConnectorConfig } from './types';

const CLASSIFICATION_STYLES: Record<ConnectorDataClassification, string> = {
  standard: 'border-cyan-800/40 bg-cyan-950/25 text-cyan-300',
  restricted: 'border-amber-800/45 bg-amber-950/25 text-amber-300',
  'local-only': 'border-emerald-800/45 bg-emerald-950/25 text-emerald-300',
};

function ClassificationIcon({
  classification,
  size = 11,
}: {
  classification: ConnectorDataClassification;
  size?: number;
}) {
  if (classification === 'local-only') return <HardDrive size={size} />;
  if (classification === 'restricted') return <Lock size={size} />;
  return <ShieldCheck size={size} />;
}

export function ConnectorClassificationBadge({
  classification,
  className = '',
}: {
  classification: ConnectorDataClassification;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${CLASSIFICATION_STYLES[classification]} ${className}`}
    >
      <ClassificationIcon classification={classification} />
      {DATA_CLASSIFICATION_LABELS[classification]}
    </span>
  );
}

interface ConnectorClassificationSelection {
  override: ConnectorDataClassification | null;
}

const ConnectorClassificationContext = createContext<ConnectorClassificationSelection>({
  override: null,
});

export function ConnectorClassificationProvider({
  override,
  children,
}: ConnectorClassificationSelection & { children: ReactNode }) {
  const value = useMemo(() => ({ override }), [override]);
  return (
    <ConnectorClassificationContext.Provider value={value}>
      {children}
    </ConnectorClassificationContext.Provider>
  );
}

export function useConnectorClassificationSelection() {
  return useContext(ConnectorClassificationContext);
}

export function ConnectorClassificationSetup({
  connectorType,
  baseline: configuredBaseline,
  override,
  onChange,
}: {
  connectorType: string;
  baseline?: ConnectorDataClassification;
  override: ConnectorDataClassification | null;
  onChange: (value: ConnectorDataClassification | null) => void;
}) {
  const baseline = configuredBaseline ?? connectorBaselineClassification(connectorType);
  const effective = override ?? baseline;
  return (
    <section className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-semibold text-[var(--text-secondary)]">Data handling</h4>
            <ConnectorClassificationBadge classification={effective} />
          </div>
          <p className="mt-1 max-w-md text-xs leading-5 text-[var(--text-muted)]">
            {DATA_CLASSIFICATION_DESCRIPTIONS[effective]}
          </p>
        </div>
        <ClassificationSelect
          baseline={baseline}
          override={override}
          onChange={onChange}
          ariaLabel="Data classification override"
        />
      </div>
    </section>
  );
}

function ClassificationSelect({
  baseline,
  override,
  onChange,
  ariaLabel,
}: {
  baseline: ConnectorDataClassification;
  override: ConnectorDataClassification | null;
  onChange: (value: ConnectorDataClassification | null) => void;
  ariaLabel: string;
}) {
  return (
    <Select
      value={override ?? 'automatic'}
      onValueChange={(value) => onChange(
        value === 'automatic' ? null : value as ConnectorDataClassification,
      )}
    >
      <SelectTrigger className="min-h-10 w-full sm:w-52" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="automatic">
          Automatic ({DATA_CLASSIFICATION_LABELS[baseline]})
        </SelectItem>
        {connectorClassificationOptions(baseline)
          .filter((classification) => classification !== baseline)
          .map((classification) => (
            <SelectItem key={classification} value={classification}>
              {DATA_CLASSIFICATION_LABELS[classification]}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

export function ConnectorDataHandlingEditor({
  connector,
  onUpdate,
}: {
  connector: ConnectorConfig;
  onUpdate: (id: string, updates: Partial<ConnectorConfig>) => Promise<void>;
}) {
  const summary = connector.dataClassification ?? {
    baseline: connectorBaselineClassification(connector.type),
    effective: connectorBaselineClassification(connector.type),
    override: null,
  };
  const [override, setOverride] = useState<ConnectorDataClassification | null>(summary.override);
  const [savedOverride, setSavedOverride] =
    useState<ConnectorDataClassification | null>(summary.override);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    setOverride(summary.override);
    setSavedOverride(summary.override);
    setStatus('idle');
  }, [summary.override]);

  const effective = override ?? summary.baseline;
  const dirty = override !== savedOverride;

  async function save() {
    setStatus('saving');
    try {
      await onUpdate(connector.id, {
        settings: {
          ...(connector.settings || {}),
          dataClassificationOverride: override,
        },
      });
      setSavedOverride(override);
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  return (
    <section className="border-t border-[var(--border)] px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-semibold text-[var(--text-secondary)]">Data handling</h4>
            <ConnectorClassificationBadge classification={effective} />
            {override && (
              <span className="text-[11px] text-[var(--text-muted)]">
                stricter than the {DATA_CLASSIFICATION_LABELS[summary.baseline].toLowerCase()} default
              </span>
            )}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--text-muted)]">
            {DATA_CLASSIFICATION_DESCRIPTIONS[effective]} Automatic handling uses the secure
            default for this connector type; overrides can only make it stricter.
          </p>
          {status === 'error' && (
            <p role="alert" className="mt-1 text-xs text-red-400">
              Data handling could not be saved. Try again.
            </p>
          )}
          {status === 'saved' && (
            <p role="status" className="mt-1 text-xs text-emerald-400">Data handling saved.</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <ClassificationSelect
            baseline={summary.baseline}
            override={override}
            onChange={(value) => {
              setOverride(value);
              setStatus('idle');
            }}
            ariaLabel={`Data classification for ${connector.name}`}
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || status === 'saving'}
            className="min-h-9 rounded-lg bg-[var(--accent-600)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-500)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === 'saving' ? 'Saving...' : 'Save data handling'}
          </button>
        </div>
      </div>
    </section>
  );
}
