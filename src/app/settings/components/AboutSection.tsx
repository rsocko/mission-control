'use client';

import { useEffect, useState } from 'react';
import {
  BookOpen,
  ExternalLink,
  Github,
  LifeBuoy,
  Scale,
} from 'lucide-react';
import {
  APP_DESCRIPTION,
  APP_DOCUMENTATION_URL,
  APP_LICENSING_URL,
  APP_NAME,
  APP_REPOSITORY_URL,
  APP_SUPPORT_URL,
  APP_VERSION,
} from '@/lib/app-metadata';

const ABOUT_LINKS = [
  {
    title: 'Source code',
    description: 'View the project and its release history on GitHub.',
    href: APP_REPOSITORY_URL,
    icon: Github,
  },
  {
    title: 'Documentation',
    description: 'Read setup, architecture, and development guides.',
    href: APP_DOCUMENTATION_URL,
    icon: BookOpen,
  },
  {
    title: 'Support and feedback',
    description: 'Search existing issues or report a problem.',
    href: APP_SUPPORT_URL,
    icon: LifeBuoy,
  },
  {
    title: 'Licensing status',
    description: 'Review the current licensing and contribution terms.',
    href: APP_LICENSING_URL,
    icon: Scale,
  },
];

function formatBuildRevision(revision: string): string {
  if (revision === 'unreported') return 'Unreported';
  if (revision === 'invalid') return 'Invalid configuration';
  return /^[0-9a-f]{13,64}$/i.test(revision) ? revision.slice(0, 12) : revision;
}

export function AboutSection() {
  const [buildRevision, setBuildRevision] = useState<string | null>(null);
  const [buildUnavailable, setBuildUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadBuildRevision() {
      try {
        const response = await fetch('/api/health/live', { signal: controller.signal });
        if (!response.ok) throw new Error(`Build information request failed with ${response.status}`);

        const data: unknown = await response.json();
        if (
          typeof data !== 'object'
          || data === null
          || !('revision' in data)
          || typeof data.revision !== 'string'
        ) {
          throw new Error('Build information response is invalid');
        }

        setBuildRevision(formatBuildRevision(data.revision));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setBuildUnavailable(true);
      }
    }

    void loadBuildRevision();
    return () => controller.abort();
  }, []);

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold text-[var(--text-primary)]">About {APP_NAME}</h2>
      <p className="mb-6 text-sm text-[var(--text-tertiary)]">
        Project information, resources, and release details
      </p>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-5">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-violet-500">
            <span className="text-lg font-bold text-white">MC</span>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">{APP_NAME}</h3>
            <p className="mt-0.5 text-sm leading-5 text-[var(--text-secondary)]">{APP_DESCRIPTION}</p>
          </div>
        </div>

        <dl className="mt-5 border-t border-[var(--border)] pt-4">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-[var(--text-secondary)]">Version</dt>
            <dd className="font-mono text-sm text-[var(--text-primary)]">v{APP_VERSION}</dd>
          </div>
          <div className="mt-3 flex items-center justify-between gap-4">
            <dt className="text-sm text-[var(--text-secondary)]">Build</dt>
            <dd
              aria-live="polite"
              className="font-mono text-sm text-[var(--text-primary)]"
            >
              {buildUnavailable ? 'Unavailable' : buildRevision ?? 'Loading...'}
            </dd>
          </div>
          <div className="mt-3 flex items-center justify-between gap-4">
            <dt className="text-sm text-[var(--text-secondary)]">Distribution</dt>
            <dd className="text-sm text-[var(--text-primary)]">Self-hosted</dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-2)]">
        {ABOUT_LINKS.map(({ title, description, href, icon: Icon }, index) => (
          <a
            key={title}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center gap-3 px-5 py-4 transition-colors hover:bg-[var(--surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60 ${
              index > 0 ? 'border-t border-[var(--border)]' : ''
            }`}
          >
            <Icon size={18} className="flex-shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-[var(--text-primary)]">{title}</span>
              <span className="mt-0.5 block text-xs leading-4 text-[var(--text-tertiary)]">
                {description}
              </span>
            </span>
            <ExternalLink size={14} className="flex-shrink-0 text-[var(--text-muted)]" />
          </a>
        ))}
      </div>

      <p className="mt-5 text-xs leading-5 text-[var(--text-muted)]">
        Mission Control is community-supported and currently pre-1.0.
      </p>
    </div>
  );
}
