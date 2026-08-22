import { ExternalLink, Mail, Phone } from 'lucide-react';
import {
  buildDocumentActionHelpers,
  type DocumentTaskMetadata,
} from './document-workspace';

export function ActionHelpersSection({ metadata }: { metadata: DocumentTaskMetadata }) {
  const helpers = buildDocumentActionHelpers(metadata);
  if (helpers.links.length === 0 && !helpers.accountNumber && !helpers.referenceNumber) {
    return null;
  }

  return (
    <section
      aria-labelledby="action-helpers-heading"
      className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-3"
    >
      <h2 id="action-helpers-heading" className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        Take action
      </h2>
      {helpers.links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {helpers.links.map((link) => {
            const Icon = link.kind === 'phone' ? Phone : link.kind === 'email' ? Mail : ExternalLink;
            return (
              <a
                key={link.href}
                href={link.href}
                target={link.kind === 'web' ? '_blank' : undefined}
                rel={link.kind === 'web' ? 'noopener noreferrer' : undefined}
                className={link.primary
                  ? 'inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90'
                  : 'inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]'}
              >
                <Icon size={13} aria-hidden="true" />
                {link.label}
              </a>
            );
          })}
        </div>
      )}
      {(helpers.accountNumber || helpers.referenceNumber) && (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {helpers.accountNumber && (
            <div className="flex gap-1.5">
              <dt className="text-[var(--text-muted)]">Account</dt>
              <dd className="font-mono text-[var(--text-secondary)]">{helpers.accountNumber}</dd>
            </div>
          )}
          {helpers.referenceNumber && (
            <div className="flex gap-1.5">
              <dt className="text-[var(--text-muted)]">Reference</dt>
              <dd className="font-mono text-[var(--text-secondary)]">{helpers.referenceNumber}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
