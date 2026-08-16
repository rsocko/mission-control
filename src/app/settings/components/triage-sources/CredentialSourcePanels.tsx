'use client';

import { useState, type ReactNode } from 'react';
import {
  Bookmark,
  CheckCircle2,
  Eye,
  EyeOff,
  FolderTree,
  Loader2,
  MessageCircle,
  Save,
  SquarePlay,
  Trash2,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConnectorBrandIcon } from '../ConnectorBrandIcon';
import { useCredentialSource, type CredentialSource } from './useCredentialSource';

type ChangedHandler = () => void | Promise<void>;

interface SourcePanelProps {
  configured: boolean;
  onChanged: ChangedHandler;
}

function SourcePanelFrame({
  title,
  description,
  configured,
  icon,
  children,
}: {
  title: string;
  description: string;
  configured: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`triage-source-${title.toLowerCase().replaceAll(' ', '-')}`}
      className="rounded-[14px] border border-[var(--border)] bg-[var(--surface-1)] p-5"
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {icon}
          <div>
            <h3
              id={`triage-source-${title.toLowerCase().replaceAll(' ', '-')}`}
              className="text-sm font-semibold text-[var(--text-primary)]"
            >
              {title}
            </h3>
            <p className="text-xs text-[var(--text-tertiary)]">{description}</p>
          </div>
        </div>
        {configured && (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-400">
            <CheckCircle2 size={12} /> Connected
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function SecretField({
  label,
  value,
  onChange,
  placeholder,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  help?: ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">{label}</label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
          className="w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 pr-10 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
        />
        <button
          type="button"
          onClick={() => setVisible(current => !current)}
          aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {help && <p className="mt-1 text-[12px] text-[var(--text-muted)]">{help}</p>}
    </div>
  );
}

function SourceActions({
  source,
  configured,
  canSave,
  status,
  error,
  onSave,
  onRemove,
}: {
  source: CredentialSource;
  configured: boolean;
  canSave: boolean;
  status: string;
  error: string | null;
  onSave: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const label = source === 'github' ? 'GitHub' : source === 'reddit' ? 'Reddit' : source === 'youtube' ? 'YouTube' : 'Karakeep';
  return (
    <>
      <div className="mt-4 flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
        <button
          type="button"
          onClick={() => { void onSave().catch(() => undefined); }}
          disabled={!canSave || status === 'saving' || status === 'deleting'}
          className="flex items-center gap-1.5 rounded-[8px] bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {status === 'saving' ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save
        </button>
        {configured && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={status === 'deleting' || status === 'saving'}
            className="flex items-center gap-1.5 rounded-[8px] border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-40"
          >
            {status === 'deleting' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            Remove
          </button>
        )}
        {status === 'saved' && <span className="text-xs text-emerald-400">{label} credentials saved</span>}
        {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
      </div>
      <ConfirmDialog
        open={confirming}
        title={`Remove ${label} credentials?`}
        message={`This will remove your ${label} triage source credentials. You can reconfigure them later.`}
        confirmLabel="Remove"
        confirmVariant="danger"
        onConfirm={() => {
          setConfirming(false);
          void onRemove().catch(() => undefined);
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

export function GitHubSourcePanel({
  configured,
  connectedViaConnector,
  pat,
  username,
  onChanged,
}: SourcePanelProps & {
  connectedViaConnector: boolean;
  pat: string;
  username: string;
}) {
  const source = useCredentialSource({
    source: 'github',
    initialCredentials: { pat, username },
    configured,
    onChanged,
  });
  return (
    <SourcePanelFrame
      title="GitHub Stars"
      description="Import your starred repositories"
      configured={configured}
      icon={<div className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-violet-500/20 bg-violet-500/10"><FolderTree size={16} className="text-violet-400" /></div>}
    >
      {connectedViaConnector ? (
        <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-0)] px-4 py-3">
          <p className="text-sm text-[var(--text-secondary)]">GitHub is connected via the Issues connector. Star imports will use the same connection.</p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            <SecretField
              label="Personal Access Token"
              value={source.credentials.pat}
              onChange={value => source.setCredential('pat', value)}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              help={<>Needs <code className="rounded bg-[var(--surface-2)] px-1 text-[12px]">read:user</code> scope. Create one at github.com/settings/tokens.</>}
            />
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">Username <span className="text-[var(--text-muted)]">(optional)</span></label>
              <input
                value={source.credentials.username}
                onChange={event => source.setCredential('username', event.target.value)}
                placeholder="your-github-username"
                className="w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
            </div>
          </div>
          <SourceActions source="github" configured={configured} canSave={Boolean(source.credentials.pat)} status={source.status} error={source.error} onSave={source.save} onRemove={source.remove} />
        </>
      )}
    </SourcePanelFrame>
  );
}

export function RedditSourcePanel({
  configured,
  clientId,
  clientSecret,
  refreshToken,
  username,
  onChanged,
}: SourcePanelProps & {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  username: string;
}) {
  const source = useCredentialSource({
    source: 'reddit',
    initialCredentials: { clientId, clientSecret, refreshToken, username },
    configured,
    onChanged,
  });
  return (
    <SourcePanelFrame
      title="Reddit Saved"
      description="Import your saved posts and comments"
      configured={configured}
      icon={<div className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-orange-500/20 bg-orange-500/10"><MessageCircle size={16} className="text-orange-400" /></div>}
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">Client ID</label>
          <input value={source.credentials.clientId} onChange={event => source.setCredential('clientId', event.target.value)} placeholder="your-app-client-id" className="w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none" />
        </div>
        <SecretField label="Client Secret" value={source.credentials.clientSecret} onChange={value => source.setCredential('clientSecret', value)} placeholder="your-app-client-secret" />
        <SecretField label="Refresh Token" value={source.credentials.refreshToken} onChange={value => source.setCredential('refreshToken', value)} placeholder="your-refresh-token" help="Create a Reddit script app at reddit.com/prefs/apps and generate a refresh token via OAuth2." />
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">Username <span className="text-[var(--text-muted)]">(optional)</span></label>
          <input value={source.credentials.username} onChange={event => source.setCredential('username', event.target.value)} placeholder="your-reddit-username" className="w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none" />
        </div>
      </div>
      <SourceActions source="reddit" configured={configured} canSave={Boolean(source.credentials.clientId && source.credentials.clientSecret && source.credentials.refreshToken)} status={source.status} error={source.error} onSave={source.save} onRemove={source.remove} />
    </SourcePanelFrame>
  );
}

export function YouTubeSourcePanel({
  configured,
  clientId,
  clientSecret,
  refreshToken,
  onChanged,
  children,
}: SourcePanelProps & {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  children?: ReactNode;
}) {
  const source = useCredentialSource({
    source: 'youtube',
    initialCredentials: { clientId, clientSecret, refreshToken },
    configured,
    onChanged,
  });
  return (
    <SourcePanelFrame
      title="YouTube Playlists"
      description="Import videos from Watch Later, Liked Videos, and custom playlists"
      configured={configured}
      icon={<div className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-red-500/20 bg-red-500/10"><SquarePlay size={16} className="text-red-400" /></div>}
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">Client ID</label>
          <input value={source.credentials.clientId} onChange={event => source.setCredential('clientId', event.target.value)} placeholder="your-oauth-client-id.apps.googleusercontent.com" className="w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none" />
        </div>
        <SecretField label="Client Secret" value={source.credentials.clientSecret} onChange={value => source.setCredential('clientSecret', value)} placeholder="your-oauth-client-secret" />
        <SecretField label="Refresh Token" value={source.credentials.refreshToken} onChange={value => source.setCredential('refreshToken', value)} placeholder="your-refresh-token" help="Create an OAuth client with the YouTube Data API v3 and youtube.readonly scope." />
      </div>
      <SourceActions source="youtube" configured={configured} canSave={Boolean(source.credentials.clientId && source.credentials.clientSecret && source.credentials.refreshToken)} status={source.status} error={source.error} onSave={source.save} onRemove={source.remove} />
      {children}
    </SourcePanelFrame>
  );
}

export function KarakeepSourcePanel({
  configured,
  configuredViaEnv,
  url,
  onChanged,
}: SourcePanelProps & {
  configuredViaEnv: boolean;
  url: string;
}) {
  const source = useCredentialSource({
    source: 'karakeep',
    initialCredentials: { url, apiKey: '' },
    configured,
    optionalConfiguredKeys: ['apiKey'],
    onChanged,
  });
  return (
    <SourcePanelFrame
      title="Karakeep"
      description="Save triage items as bookmarks"
      configured={configured}
      icon={<div className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-blue-500/20 bg-blue-500/10"><Bookmark size={16} className="text-blue-400" /></div>}
    >
      {configuredViaEnv && !url ? (
        <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-0)] px-4 py-3">
          <p className="text-sm text-[var(--text-secondary)]">Karakeep is connected via environment variables (MC_KARAKEEP_URL + MC_KARAKEEP_API_KEY).</p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">Instance URL</label>
              <input value={source.credentials.url} onChange={event => source.setCredential('url', event.target.value)} placeholder="https://karakeep.example.com" className="w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none" />
              <p className="mt-1 text-[12px] text-[var(--text-muted)]">The base URL of your Karakeep instance.</p>
            </div>
            <SecretField label="API Key" value={source.credentials.apiKey} onChange={value => source.setCredential('apiKey', value)} placeholder={configured ? 'Key configured — enter new key to change' : 'your-karakeep-api-key'} help="Generate an API key in your Karakeep settings." />
          </div>
          <SourceActions source="karakeep" configured={configured} canSave={Boolean(source.credentials.url && (source.credentials.apiKey || configured))} status={source.status} error={source.error} onSave={source.save} onRemove={source.remove} />
        </>
      )}
    </SourcePanelFrame>
  );
}

export function DocumentIntelligenceSourcePanel({
  autoSyncEnabled,
  intervalMinutes,
  saving,
  onToggle,
  onIntervalChange,
}: {
  autoSyncEnabled: boolean;
  intervalMinutes: number;
  saving: boolean;
  onToggle: (enabled: boolean) => void;
  onIntervalChange: (minutes: number) => void;
}) {
  return (
    <SourcePanelFrame
      title="OWL"
      description="Import Paperless-ngx document actions into the triage gallery"
      configured
      icon={<div className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-blue-500/20 bg-blue-500/10"><ConnectorBrandIcon type="document-intelligence" size={16} /></div>}
    >
      <div className="flex items-center justify-between border-t border-[var(--border-subtle)] pt-3">
        <div>
          <p className="text-xs font-medium text-[var(--text-secondary)]">Auto-Sync Schedule</p>
          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">Automatically import new document actions</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="OWL auto-sync"
          aria-checked={autoSyncEnabled}
          disabled={saving}
          onClick={() => onToggle(!autoSyncEnabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50 ${autoSyncEnabled ? 'bg-blue-600' : 'bg-[var(--surface-3)]'}`}
        >
          <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ${autoSyncEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
      </div>
      {autoSyncEnabled && (
        <div className="mt-3 flex items-center gap-3 border-t border-[var(--border-subtle)] pt-3">
          <label className="text-xs text-[var(--text-secondary)]">Sync every</label>
          <Select value={String(intervalMinutes)} onValueChange={value => onIntervalChange(Number(value))} disabled={saving}>
            <SelectTrigger variant="inline" aria-label="OWL sync interval"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="5">5 minutes</SelectItem>
              <SelectItem value="10">10 minutes</SelectItem>
              <SelectItem value="15">15 minutes</SelectItem>
              <SelectItem value="30">30 minutes</SelectItem>
              <SelectItem value="60">1 hour</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </SourcePanelFrame>
  );
}
