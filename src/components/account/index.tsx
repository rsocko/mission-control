'use client';

/**
 * Account Badge — Visual indicator showing which account/instance a task belongs to.
 * Shows personal vs work with different colors and hover details.
 */

import { AlertTriangle, Check, X } from 'lucide-react';

interface AccountBadgeProps {
  connectorType: string;
  connectorInstanceId: string;
  accountType?: 'personal' | 'work' | 'unknown';
  accountEmail?: string;
  size?: 'sm' | 'md';
}

const CONNECTOR_LABELS: Record<string, string> = {
  'microsoft-todo': 'Todo',
  'github-issues': 'GitHub',
  'outlook-email': 'Email',
  'outlook-calendar': 'Calendar',
  'rymessage': 'RyMessage',
  'document-intelligence': 'Docs',
  'custom-rest': 'Custom',
};

const ACCOUNT_STYLES = {
  personal: {
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    text: 'text-blue-700',
    dot: 'bg-blue-400',
    label: 'Personal',
  },
  work: {
    bg: 'bg-purple-50',
    border: 'border-purple-200',
    text: 'text-purple-700',
    dot: 'bg-purple-400',
    label: 'Work',
  },
  unknown: {
    bg: 'bg-gray-50',
    border: 'border-gray-200',
    text: 'text-gray-600',
    dot: 'bg-gray-400',
    label: '',
  },
};

export function AccountBadge({
  connectorType,
  connectorInstanceId,
  accountType = 'unknown',
  accountEmail,
  size = 'sm',
}: AccountBadgeProps) {
  const style = ACCOUNT_STYLES[accountType];
  const label = CONNECTOR_LABELS[connectorType] || connectorType;

  if (size === 'sm') {
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border ${style.bg} ${style.border} ${style.text}`}
        title={accountEmail ? `${accountEmail} (${style.label || accountType})` : connectorInstanceId}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
        {style.label && <span>{style.label}</span>}
        <span className="opacity-70">{label}</span>
      </span>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-md border ${style.bg} ${style.border}`}
      title={accountEmail || connectorInstanceId}
    >
      <span className={`w-2 h-2 rounded-full ${style.dot}`} />
      <div className="min-w-0">
        <p className={`text-xs font-medium ${style.text}`}>
          {style.label ? `${style.label} · ` : ''}{label}
        </p>
        {accountEmail && (
          <p className="text-xs text-gray-400 truncate">{accountEmail}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Account Selector — For picking destination account when adding/moving tasks
 */
interface AccountOption {
  instanceId: string;
  connectorType: string;
  name: string;
  accountType: 'personal' | 'work';
  email?: string;
}

interface AccountSelectorProps {
  accounts: AccountOption[];
  selected: string | null;
  onSelect: (instanceId: string) => void;
  label?: string;
}

export function AccountSelector({ accounts, selected, onSelect, label }: AccountSelectorProps) {
  if (accounts.length <= 1) return null;

  return (
    <div>
      {label && <label className="text-xs font-medium text-gray-600 block mb-1">{label}</label>}
      <div className="flex gap-2 flex-wrap">
        {accounts.map(acc => {
          const isSelected = selected === acc.instanceId;
          const style = ACCOUNT_STYLES[acc.accountType];
          return (
            <button
              key={acc.instanceId}
              onClick={() => onSelect(acc.instanceId)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-[background-color,color,border-color] ${
                isSelected
                  ? `${style.bg} ${style.border} ${style.text} ring-2 ring-offset-1 ring-${acc.accountType === 'work' ? 'purple' : 'blue'}-300`
                  : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${isSelected ? style.dot : 'bg-gray-300'}`} />
              <span className="font-medium">{acc.name}</span>
              {acc.email && <span className="text-xs opacity-60 hidden sm:inline">({acc.email})</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Permission Status Badge — Shows what's allowed/blocked for an account
 */
interface PermissionBadgeProps {
  canRead: boolean;
  canWrite: boolean;
  issues?: string[];
}

export function PermissionBadge({ canRead, canWrite, issues }: PermissionBadgeProps) {
  const allGood = canRead && canWrite && (!issues || issues.length === 0);

  return (
    <div className={`flex items-center gap-2 px-2 py-1 rounded text-xs ${
      allGood ? 'bg-green-50 text-green-700' : 'bg-yellow-50 text-yellow-700'
    }`}>
      <span>{allGood ? <Check size={12} className="inline" /> : <AlertTriangle size={12} className="inline" />}</span>
      <span>
        {canRead ? 'Read' : <><X size={10} className="inline" /> Read</>}
        {' · '}
        {canWrite ? 'Write' : <><X size={10} className="inline" /> Write</>}
      </span>
      {issues && issues.length > 0 && (
        <span className="text-xs text-yellow-600" title={issues.join('\n')}>
          ({issues.length} issue{issues.length > 1 ? 's' : ''})
        </span>
      )}
    </div>
  );
}