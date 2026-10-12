'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeftRight, Bell, Globe } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { IconRenderer } from '@rsocko/icon-picker/renderer';
import { CONNECTOR_ICON_PATHS } from '@/lib/constants/colors';

const CONNECTOR_NAMES: Record<string, string> = {
  'local': 'Local',
  'microsoft-todo': 'Microsoft Todo',
  'github-issues': 'GitHub Issues',
  'outlook-email': 'Outlook Email',
  'outlook-calendar': 'Outlook Calendar',
  'scout': 'Microsoft Scout',
  'rymessage': 'RyMessage',
  'document-intelligence': 'OWL',
  'custom-rest': 'Custom REST',
};

interface LinkedSource {
  id: string;
  taskId: string;
  connectorType: string;
  connectorInstanceId: string;
  sourceId: string;
  title: string;
  linkedAt: string;
  matchConfidence: number | null;
  metadata: Record<string, unknown>;
}

export function LinkedSourcesSection({
  taskId,
  sourceNotificationId,
  sourceNotificationConnectorType,
  sourceNotificationTitle,
}: {
  taskId: string;
  sourceNotificationId?: string;
  sourceNotificationConnectorType?: string;
  sourceNotificationTitle?: string;
}) {
  const [linkedSources, setLinkedSources] = useState<LinkedSource[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/tasks/${taskId}/linked-sources`)
      .then((r) => r.json())
      .then((data) => {
        setLinkedSources(data.linkedSources || []);
      })
      .catch(() => setLinkedSources([]))
      .finally(() => setLoading(false));
  }, [taskId]);

  if (loading || (linkedSources.length === 0 && !sourceNotificationId)) return null;

  return (
    <div className="border-t border-[var(--border-subtle)] pt-3 mt-4">
      <div className="flex items-center gap-2 mb-2">
        <ArrowLeftRight size={14} className="text-cyan-400" />
        <span className="text-xs font-medium text-[var(--text-secondary)]">
          Also tracked in
        </span>
      </div>
      <div className="space-y-1.5">
        {sourceNotificationId && (
          <Link
            href={`/notifications?id=${encodeURIComponent(sourceNotificationId)}`}
            className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-0)] px-2 py-1.5 transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Bell size={14} className="shrink-0 text-cyan-400" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
                {sourceNotificationTitle || 'Source notification'}
              </span>
              <span className="block truncate text-[10px] text-[var(--text-muted)]">
                {sourceNotificationConnectorType === 'home-assistant'
                  ? 'Home Assistant notification'
                  : 'Mission Control notification'}
              </span>
            </div>
          </Link>
        )}
        {linkedSources.map((source) => (
          <div
            key={source.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[var(--surface-0)] border border-[var(--border-subtle)]"
          >
            <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
              {CONNECTOR_ICON_PATHS[source.connectorType] ? (
                CONNECTOR_ICON_PATHS[source.connectorType].startsWith('dash:') ? (
                  <IconRenderer
                    value={CONNECTOR_ICON_PATHS[source.connectorType]}
                    size={14}
                  />
                ) : (
                  <Image
                    src={CONNECTOR_ICON_PATHS[source.connectorType]}
                    alt={source.connectorType}
                    width={14}
                    height={14}
                  />
                )
              ) : (
                <Globe size={14} className="text-[var(--text-muted)]" />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium text-[var(--text-primary)] truncate block">
                {CONNECTOR_NAMES[source.connectorType] || source.connectorType}
              </span>
              <span className="text-[10px] text-[var(--text-muted)] truncate block">
                {source.title}
              </span>
            </div>
            {source.matchConfidence != null && (
              <Tooltip content={`Match confidence: ${Math.round(source.matchConfidence * 100)}%`}>
                <span className="text-[10px] text-cyan-400 font-mono tabular-nums">
                  {Math.round(source.matchConfidence * 100)}%
                </span>
              </Tooltip>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
