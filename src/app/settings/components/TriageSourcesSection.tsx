'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Loader2, Save, FolderTree, MessageCircle, RefreshCw, SquarePlay, ListVideo, Plus, X,
} from 'lucide-react';
import { settingsLogger } from '@/lib/client-logger';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConnectorBrandIcon } from './ConnectorBrandIcon';
import {
  DocumentIntelligenceSourcePanel,
  GitHubSourcePanel,
  KarakeepSourcePanel,
  RedditSourcePanel,
  YouTubeSourcePanel,
} from './triage-sources/CredentialSourcePanels';

interface TriageSourceConfig {
  github: { pat: string; username: string; configured: boolean; connectedViaConnector: boolean };
  reddit: { clientId: string; clientSecret: string; refreshToken: string; username: string; configured: boolean };
  youtube: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    playlists: Array<{ id: string; label: string; enabled: boolean }>;
    configured: boolean;
  };
  karakeep: { url: string; apiKey: string; configured: boolean; configuredViaEnv: boolean };
}

interface PlaylistSyncState {
  id: string;
  lastSyncedAt: string | null;
  lastRunImported: number;
  lastRunSkipped: number;
}

function TriageSourcesSection() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<TriageSourceConfig | null>(null);
  const [configRevision, setConfigRevision] = useState(0);
  const [statusMessage, setStatusMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  // Auto-sync schedule state
  const [ghAutoSyncEnabled, setGhAutoSyncEnabled] = useState(false);
  const [ghAutoSyncInterval, setGhAutoSyncInterval] = useState(30);
  const [ytAutoSyncEnabled, setYtAutoSyncEnabled] = useState(false);
  const [ytAutoSyncInterval, setYtAutoSyncInterval] = useState(60);
  const [diAutoSyncEnabled, setDiAutoSyncEnabled] = useState(false);
  const [diAutoSyncInterval, setDiAutoSyncInterval] = useState(15);
  const [diConnectorConfigured, setDiConnectorConfigured] = useState(false);
  const [autoSyncSaving, setAutoSyncSaving] = useState(false);

  // Manual sync state
  const [syncMode, setSyncMode] = useState<'incremental' | 'full'>('incremental');
  const [syncingSource, setSyncingSource] = useState<'github-stars' | 'reddit-saved' | 'youtube' | 'document-intelligence' | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // YouTube playlist editor state
  const [playlists, setPlaylists] = useState<Array<{ id: string; label: string; enabled: boolean }>>([]);
  const [playlistSyncStates, setPlaylistSyncStates] = useState<PlaylistSyncState[]>([]);
  const [newPlaylistId, setNewPlaylistId] = useState('');
  const [newPlaylistLabel, setNewPlaylistLabel] = useState('');
  const [playlistsSaving, setPlaylistsSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const [sourceRes, autoSyncRes, syncStatusRes, connectorsRes] = await Promise.all([
        fetch('/api/triage/sources'),
        fetch('/api/triage/auto-sync'),
        fetch('/api/triage/sync-status'),
        fetch('/api/connectors'),
      ]);
      const data = await sourceRes.json();
      setConfig(data);
      setConfigRevision(revision => revision + 1);
      setPlaylists(data.youtube?.playlists || []);

      if (autoSyncRes.ok) {
        const autoSyncData = await autoSyncRes.json();
        const ghCfg = autoSyncData.config?.sources?.['github-stars'];
        if (ghCfg) {
          setGhAutoSyncEnabled(ghCfg.enabled ?? false);
          setGhAutoSyncInterval(ghCfg.intervalMinutes ?? 30);
        }
        const ytCfg = autoSyncData.config?.sources?.['youtube'];
        if (ytCfg) {
          setYtAutoSyncEnabled(ytCfg.enabled ?? false);
          setYtAutoSyncInterval(ytCfg.intervalMinutes ?? 60);
        }
        const diCfg = autoSyncData.config?.sources?.['document-intelligence'];
        if (diCfg) {
          setDiAutoSyncEnabled(diCfg.enabled ?? false);
          setDiAutoSyncInterval(diCfg.intervalMinutes ?? 15);
        }
      }

      if (syncStatusRes.ok) {
        const syncStatusData = await syncStatusRes.json();
        setPlaylistSyncStates(syncStatusData.sources?.youtube?.playlistSyncStates || []);
      }

      if (connectorsRes.ok) {
        const connectorsData = await connectorsRes.json();
        const hasDi = Array.isArray(connectorsData.connectors) && connectorsData.connectors.some(
          (c: { type?: string; enabled?: boolean }) => c.type === 'document-intelligence' && c.enabled !== false
        );
        setDiConnectorConfigured(hasDi);
      }
    } catch (error) {
      settingsLogger.error('Failed to load triage sources config', { err: error });
    } finally {
      setLoading(false);
    }
  }, []);

  async function handleAutoSyncToggle(enabled: boolean) {
    setAutoSyncSaving(true);
    setGhAutoSyncEnabled(enabled);
    try {
      await fetch('/api/triage/auto-sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: { 'github-stars': { enabled, intervalMinutes: ghAutoSyncInterval } } }),
      });
    } catch {
      setGhAutoSyncEnabled(!enabled);
    } finally {
      setAutoSyncSaving(false);
    }
  }

  async function handleAutoSyncIntervalChange(minutes: number) {
    setAutoSyncSaving(true);
    setGhAutoSyncInterval(minutes);
    try {
      await fetch('/api/triage/auto-sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: { 'github-stars': { enabled: ghAutoSyncEnabled, intervalMinutes: minutes } } }),
      });
    } catch {
      // revert on error
    } finally {
      setAutoSyncSaving(false);
    }
  }

  async function handleYoutubeAutoSyncToggle(enabled: boolean) {
    setAutoSyncSaving(true);
    setYtAutoSyncEnabled(enabled);
    try {
      await fetch('/api/triage/auto-sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: { youtube: { enabled, intervalMinutes: ytAutoSyncInterval } } }),
      });
    } catch {
      setYtAutoSyncEnabled(!enabled);
    } finally {
      setAutoSyncSaving(false);
    }
  }

  async function handleYoutubeAutoSyncIntervalChange(minutes: number) {
    setAutoSyncSaving(true);
    setYtAutoSyncInterval(minutes);
    try {
      await fetch('/api/triage/auto-sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: { youtube: { enabled: ytAutoSyncEnabled, intervalMinutes: minutes } } }),
      });
    } catch {
      // revert on error
    } finally {
      setAutoSyncSaving(false);
    }
  }

  async function handleDiAutoSyncToggle(enabled: boolean) {
    setAutoSyncSaving(true);
    setDiAutoSyncEnabled(enabled);
    try {
      await fetch('/api/triage/auto-sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: { 'document-intelligence': { enabled, intervalMinutes: diAutoSyncInterval } } }),
      });
    } catch {
      setDiAutoSyncEnabled(!enabled);
    } finally {
      setAutoSyncSaving(false);
    }
  }

  async function handleDiAutoSyncIntervalChange(minutes: number) {
    setAutoSyncSaving(true);
    setDiAutoSyncInterval(minutes);
    try {
      await fetch('/api/triage/auto-sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: { 'document-intelligence': { enabled: diAutoSyncEnabled, intervalMinutes: minutes } } }),
      });
    } catch {
      // revert on error
    } finally {
      setAutoSyncSaving(false);
    }
  }

  async function handleManualSync(sourceKey: 'github-stars' | 'reddit-saved' | 'youtube' | 'document-intelligence') {
    setSyncingSource(sourceKey);
    setSyncResult(null);
    try {
      const importPath = sourceKey;
      const body = sourceKey === 'youtube'
        ? { mode: syncMode, playlistIds: playlists.filter((p) => p.enabled).map((p) => p.id) }
        : { mode: syncMode };
      const response = await fetch(`/api/triage/import/${importPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setSyncResult(data.error || 'Import failed');
      } else {
        const sourceLabel = sourceKey === 'github-stars' ? 'GitHub Stars' : sourceKey === 'reddit-saved' ? 'Reddit Saved' : sourceKey === 'document-intelligence' ? 'OWL' : 'YouTube';
        if (data.result) {
          const result = data.result as { imported: number; skipped: number; pagesProcessed: number; durationMs: number };
          const duration = result.durationMs < 1000 ? `${result.durationMs}ms` : `${(result.durationMs / 1000).toFixed(1)}s`;
          setSyncResult(`${sourceLabel}: ${result.imported} imported, ${result.skipped} skipped across ${result.pagesProcessed} page${result.pagesProcessed !== 1 ? 's' : ''} (${duration})`);
        } else if (data.summary) {
          const summary = data.summary as { imported: number; skipped: number; nextCursor?: string | null };
          setSyncResult(`${sourceLabel}: imported ${summary.imported}, skipped ${summary.skipped}${summary.nextCursor ? ', more available' : ''}.`);
        } else {
          setSyncResult(`${sourceLabel}: sync complete.`);
        }
      }
    } catch {
      setSyncResult('Sync failed — check your connection.');
    } finally {
      setSyncingSource(null);
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadConfig();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadConfig]);

  async function savePlaylists(updated: Array<{ id: string; label: string; enabled: boolean }>) {
    setPlaylists(updated);
    setPlaylistsSaving(true);
    try {
      await fetch('/api/triage/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'youtube', playlists: updated }),
      });
      const syncStatusRes = await fetch('/api/triage/sync-status');
      if (syncStatusRes.ok) {
        const syncStatusData = await syncStatusRes.json();
        setPlaylistSyncStates(syncStatusData.sources?.youtube?.playlistSyncStates || []);
      }
    } catch {
      setStatusMessage({ tone: 'error', text: 'Failed to save playlist changes' });
    } finally {
      setPlaylistsSaving(false);
    }
  }

  function handleAddPlaylist() {
    const id = newPlaylistId.trim();
    if (!id || playlists.some((p) => p.id === id)) return;
    const label = newPlaylistLabel.trim() || id;
    savePlaylists([...playlists, { id, label, enabled: true }]);
    setNewPlaylistId('');
    setNewPlaylistLabel('');
  }

  function handleRemovePlaylist(id: string) {
    savePlaylists(playlists.filter((p) => p.id !== id));
  }

  function handleTogglePlaylist(id: string, enabled: boolean) {
    savePlaylists(playlists.map((p) => (p.id === id ? { ...p, enabled } : p)));
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]">
        <Loader2 size={14} className="animate-spin" /> Loading triage source settings…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Triage Sources</h2>
        <p className="mt-1 text-sm text-[var(--text-tertiary)]">
          Credentials for Reddit and GitHub Stars auto-import.
        </p>
      </div>

      <GitHubSourcePanel
        key={`github-${configRevision}`}
        configured={config?.github.configured ?? false}
        connectedViaConnector={config?.github.connectedViaConnector ?? false}
        pat={config?.github.pat ?? ''}
        username={config?.github.username ?? ''}
        onChanged={loadConfig}
      />

      {/* GitHub Stars Auto-Sync Schedule */}
      {config?.github.configured && (
        <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Auto-Sync Schedule</h3>
            <button
              type="button"
              role="switch"
              aria-checked={ghAutoSyncEnabled}
              disabled={autoSyncSaving}
              onClick={() => handleAutoSyncToggle(!ghAutoSyncEnabled)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50 ${ghAutoSyncEnabled ? 'bg-blue-600' : 'bg-[var(--surface-3)]'}`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ${ghAutoSyncEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
            </button>
          </div>

          {ghAutoSyncEnabled && (
            <div className="flex items-center gap-3 pt-2 border-t border-[var(--border-subtle)]">
              <label className="text-xs text-[var(--text-secondary)]">Sync every</label>
              <Select
                value={String(ghAutoSyncInterval)}
                onValueChange={(value) => handleAutoSyncIntervalChange(Number(value))}
                disabled={autoSyncSaving}
              >
                <SelectTrigger variant="inline" aria-label="GitHub sync interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="120">2 hours</SelectItem>
                  <SelectItem value="360">6 hours</SelectItem>
                  <SelectItem value="720">12 hours</SelectItem>
                  <SelectItem value="1440">24 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      <RedditSourcePanel
        key={`reddit-${configRevision}`}
        configured={config?.reddit.configured ?? false}
        clientId={config?.reddit.clientId ?? ''}
        clientSecret={config?.reddit.clientSecret ?? ''}
        refreshToken={config?.reddit.refreshToken ?? ''}
        username={config?.reddit.username ?? ''}
        onChanged={loadConfig}
      />

      <YouTubeSourcePanel
        key={`youtube-${configRevision}`}
        configured={config?.youtube.configured ?? false}
        clientId={config?.youtube.clientId ?? ''}
        clientSecret={config?.youtube.clientSecret ?? ''}
        refreshToken={config?.youtube.refreshToken ?? ''}
        onChanged={loadConfig}
      >
        {/* Playlist list editor — YouTube supports multiple named playlists,
            unlike the single-account GitHub/Reddit sources above. */}
        <div className="mt-4 pt-4 border-t border-[var(--border-subtle)]">
          <div className="flex items-center gap-2 mb-3">
            <ListVideo size={14} className="text-red-400" />
            <h4 className="text-xs font-semibold text-[var(--text-primary)]">Playlists</h4>
          </div>

          <div className="space-y-2 mb-3">
            {playlists.length === 0 && (
              <p className="text-xs text-[var(--text-muted)]">No playlists configured — defaults to Watch Later (WL) and Liked Videos (LL).</p>
            )}
            {playlists.map((playlist) => {
              const syncState = playlistSyncStates.find((s) => s.id === `youtube-${playlist.id}`);
              return (
                <div key={playlist.id} className="flex items-center justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-[var(--text-secondary)] truncate">{playlist.label}</span>
                      <span className="text-xs text-[var(--text-muted)] font-mono">{playlist.id}</span>
                    </div>
                    {syncState?.lastSyncedAt && (
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">
                        Last sync: {syncState.lastRunImported} imported, {syncState.lastRunSkipped} skipped ({new Date(syncState.lastSyncedAt).toLocaleString()})
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={playlist.enabled}
                      disabled={playlistsSaving}
                      onClick={() => handleTogglePlaylist(playlist.id, !playlist.enabled)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50 ${playlist.enabled ? 'bg-blue-600' : 'bg-[var(--surface-3)]'}`}
                    >
                      <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ${playlist.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemovePlaylist(playlist.id)}
                      disabled={playlistsSaving}
                      className="text-[var(--text-muted)] hover:text-red-400 disabled:opacity-40 transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newPlaylistId}
              onChange={(e) => setNewPlaylistId(e.target.value)}
              placeholder="Playlist ID (e.g. WL, LL, PLxxxx)"
              className="flex-1 rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
            <input
              type="text"
              value={newPlaylistLabel}
              onChange={(e) => setNewPlaylistLabel(e.target.value)}
              placeholder="Label (optional)"
              className="flex-1 rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            />
            <button
              type="button"
              onClick={handleAddPlaylist}
              disabled={!newPlaylistId.trim() || playlistsSaving}
              className="flex items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              <Plus size={12} /> Add
            </button>
          </div>
          {statusMessage && (
            <p role={statusMessage.tone === 'error' ? 'alert' : 'status'} className={`mt-2 text-xs ${statusMessage.tone === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
              {statusMessage.text}
            </p>
          )}
        </div>
      </YouTubeSourcePanel>

      {/* YouTube Auto-Sync Schedule */}
      {config?.youtube.configured && (
        <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Auto-Sync Schedule</h3>
            <button
              type="button"
              role="switch"
              aria-checked={ytAutoSyncEnabled}
              disabled={autoSyncSaving}
              onClick={() => handleYoutubeAutoSyncToggle(!ytAutoSyncEnabled)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50 ${ytAutoSyncEnabled ? 'bg-blue-600' : 'bg-[var(--surface-3)]'}`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ${ytAutoSyncEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
            </button>
          </div>

          {ytAutoSyncEnabled && (
            <div className="flex items-center gap-3 pt-2 border-t border-[var(--border-subtle)]">
              <label className="text-xs text-[var(--text-secondary)]">Sync every</label>
              <Select
                value={String(ytAutoSyncInterval)}
                onValueChange={(value) => handleYoutubeAutoSyncIntervalChange(Number(value))}
                disabled={autoSyncSaving}
              >
                <SelectTrigger variant="inline" aria-label="YouTube sync interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="120">2 hours</SelectItem>
                  <SelectItem value="360">6 hours</SelectItem>
                  <SelectItem value="720">12 hours</SelectItem>
                  <SelectItem value="1440">24 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {/* OWL */}
      {diConnectorConfigured && (
        <DocumentIntelligenceSourcePanel
          autoSyncEnabled={diAutoSyncEnabled}
          intervalMinutes={diAutoSyncInterval}
          saving={autoSyncSaving}
          onToggle={handleDiAutoSyncToggle}
          onIntervalChange={handleDiAutoSyncIntervalChange}
        />
      )}

      {/* Manual Sync */}
      {(config?.github.configured || config?.reddit.configured || config?.youtube.configured || diConnectorConfigured) && (
        <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Manual Sync</h3>
            <div className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-0)] p-0.5">
              <button
                type="button"
                onClick={() => setSyncMode('incremental')}
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${syncMode === 'incremental' ? 'bg-blue-600/20 text-blue-300' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}`}
              >
                New only
              </button>
              <button
                type="button"
                onClick={() => setSyncMode('full')}
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${syncMode === 'full' ? 'bg-blue-600/20 text-blue-300' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}`}
              >
                Full sync
              </button>
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-[var(--border-subtle)]">
            {config?.github.configured && (
              <div className="flex items-center justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <FolderTree size={14} className="text-violet-400" />
                  <span className="text-sm text-[var(--text-secondary)]">GitHub Stars</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleManualSync('github-stars')}
                  disabled={!!syncingSource}
                  className="flex items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {syncingSource === 'github-stars' ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  {syncingSource === 'github-stars' ? 'Syncing…' : 'Sync Now'}
                </button>
              </div>
            )}
            {config?.reddit.configured && (
              <div className="flex items-center justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <MessageCircle size={14} className="text-orange-400" />
                  <span className="text-sm text-[var(--text-secondary)]">Reddit Saved</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleManualSync('reddit-saved')}
                  disabled={!!syncingSource}
                  className="flex items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {syncingSource === 'reddit-saved' ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  {syncingSource === 'reddit-saved' ? 'Syncing…' : 'Sync Now'}
                </button>
              </div>
            )}
            {config?.youtube.configured && (
              <div className="flex items-center justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <SquarePlay size={14} className="text-red-400" />
                  <span className="text-sm text-[var(--text-secondary)]">YouTube Playlists</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleManualSync('youtube')}
                  disabled={!!syncingSource}
                  className="flex items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {syncingSource === 'youtube' ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  {syncingSource === 'youtube' ? 'Syncing…' : 'Sync Now'}
                </button>
              </div>
            )}
            {diConnectorConfigured && (
              <div className="flex items-center justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <ConnectorBrandIcon type="document-intelligence" size={14} />
                  <span className="text-sm text-[var(--text-secondary)]">OWL</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleManualSync('document-intelligence')}
                  disabled={!!syncingSource}
                  className="flex items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {syncingSource === 'document-intelligence' ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  {syncingSource === 'document-intelligence' ? 'Syncing…' : 'Sync Now'}
                </button>
              </div>
            )}
          </div>

          {syncResult && (
            <div className="mt-2 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2 text-xs text-[var(--text-secondary)]">
              {syncResult}
            </div>
          )}
        </div>
      )}

      <KarakeepSourcePanel
        key={`karakeep-${configRevision}`}
        configured={config?.karakeep?.configured ?? false}
        configuredViaEnv={config?.karakeep?.configuredViaEnv ?? false}
        url={config?.karakeep?.url ?? ''}
        onChanged={loadConfig}
      />

      <ExtensionScrapeConfigSection />
    </div>
  );
}

const SCRAPE_PLATFORMS: Array<{ id: 'reddit' | 'instagram' | 'facebook' | 'tiktok' | 'pinterest'; label: string }> = [
  { id: 'reddit', label: 'Reddit' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'pinterest', label: 'Pinterest' },
];

interface PlatformScrapeConfig {
  enabled: boolean;
  maxPages: number;
  batchSize: number;
  includedLists: string[];
  excludedLists: string[];
}

type ScrapeConfig = Record<string, PlatformScrapeConfig>;

/**
 * Settings sub-panel for `/api/triage/extension-config` (goal 3 scaffolding).
 *
 * This ONLY edits server-stored config — the browser extension's content
 * scripts (reddit-import.js, instagram-import.js, facebook-import.js,
 * tiktok-import.js, pinterest-import.js) do not yet read this config; they
 * still use their own hardcoded constants. See the API route's doc comment
 * and the PR description for the proposed wiring design. This panel is
 * useful today for previewing/persisting the intended settings ahead of
 * that extension-side follow-up.
 */
function ExtensionScrapeConfigSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<ScrapeConfig | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/triage/extension-config');
        const data = await res.json();
        if (!cancelled && res.ok) {
          setConfig(data.config?.platforms ?? null);
        }
      } catch (error) {
        settingsLogger.error('Failed to load extension scrape config', { err: error });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const updateField = (platformId: string, field: keyof PlatformScrapeConfig, value: number | boolean) => {
    setConfig((prev) => prev ? { ...prev, [platformId]: { ...prev[platformId], [field]: value } } : prev);
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/triage/extension-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platforms: config }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setConfig(data.config?.platforms ?? config);
      setMessage({ tone: 'success', text: 'Scrape config saved.' });
    } catch (error) {
      settingsLogger.error('Failed to save extension scrape config', { err: error });
      setMessage({ tone: 'error', text: 'Failed to save scrape config.' });
    } finally {
      setSaving(false);
    }
  };

  if (loading || !config) {
    return null;
  }

  return (
    <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Extension Scrape Config</h3>
        <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
          Per-platform pacing knobs for the browser extension&apos;s multi-item scraping (Reddit, Instagram, Facebook,
          TikTok, Pinterest). Scaffolding only — the extension does not read these settings yet.
        </p>
      </div>

      <div className="space-y-2">
        {SCRAPE_PLATFORMS.map(({ id, label }) => {
          const cfg = config[id];
          if (!cfg) return null;
          return (
            <div key={id} className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--text-secondary)]">{label}</span>
                <label className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                  <input
                    type="checkbox"
                    checked={cfg.enabled}
                    onChange={(e) => updateField(id, 'enabled', e.target.checked)}
                  />
                  Enabled
                </label>
              </div>
              <div className="mt-2 flex items-center gap-4 text-xs text-[var(--text-tertiary)]">
                <label className="flex items-center gap-1.5">
                  Max pages
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={cfg.maxPages}
                    onChange={(e) => updateField(id, 'maxPages', Number(e.target.value))}
                    className="w-16 rounded-[6px] border border-[var(--border)] bg-[var(--surface-1)] px-1.5 py-0.5 text-[var(--text-primary)]"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  Batch size
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={cfg.batchSize}
                    onChange={(e) => updateField(id, 'batchSize', Number(e.target.value))}
                    className="w-16 rounded-[6px] border border-[var(--border)] bg-[var(--surface-1)] px-1.5 py-0.5 text-[var(--text-primary)]"
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          {saving ? 'Saving…' : 'Save'}
        </button>
        {message && (
          <span className={`text-xs ${message.tone === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}

export { TriageSourcesSection };
