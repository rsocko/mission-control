import { FileText, MapPin } from 'lucide-react';
import type {
  BridgeStatementDescriptor,
  NormalizedLocationEvidence,
} from '@/lib/finance/transaction-evidence';

export interface TransactionLocationDetails {
  evidence: NormalizedLocationEvidence | null;
  inferenceEvidence: string | null;
  errorCode:
    | 'location_inference_unavailable'
    | 'location_inference_uncertain'
    | 'location_inference_invalid'
    | null;
}

export function TransactionEvidenceDetails({
  statementDescriptors,
  location,
  freshnessReference,
  headingIdPrefix,
}: {
  statementDescriptors: readonly BridgeStatementDescriptor[];
  location: TransactionLocationDetails;
  freshnessReference: number;
  headingIdPrefix: string;
}) {
  const descriptorHeadingId = `${headingIdPrefix}-statement-descriptors-heading`;
  const locationHeadingId = `${headingIdPrefix}-transaction-location-heading`;

  return (
    <div className="grid border-t border-[var(--border)] lg:grid-cols-2 lg:divide-x lg:divide-[var(--border)]">
      <section aria-labelledby={descriptorHeadingId} className="min-w-0 p-4 sm:p-5">
        <h3 id={descriptorHeadingId} className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <FileText className="size-4 text-sky-300" aria-hidden="true" /> Statement descriptors
        </h3>
        {statementDescriptors.length ? (
          <dl className="mt-3 space-y-3">
            {statementDescriptors.map((descriptor) => (
              <div key={`${descriptor.kind}:${descriptor.source.field}`} className="min-w-0">
                <dt className="text-xs text-[var(--text-muted)]">
                  {descriptor.kind === 'statement' ? 'Statement name' : 'Provider description'}
                </dt>
                <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--text-primary)]">
                  {descriptor.text}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            No statement descriptor was supplied for this transaction.
          </p>
        )}
      </section>
      <section aria-labelledby={locationHeadingId} className="min-w-0 border-t border-[var(--border)] p-4 sm:p-5 lg:border-t-0">
        <h3 id={locationHeadingId} className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <MapPin className="size-4 text-emerald-300" aria-hidden="true" /> Transaction geography
        </h3>
        {location.evidence ? (
          <div className="mt-3">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              {[location.evidence.locality, location.evidence.region, location.evidence.countryCode]
                .filter(Boolean)
                .join(', ')}
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {Math.round(location.evidence.confidence * 100)}% confidence · {
                location.evidence.sourceKind === 'user-confirmed'
                  ? 'User confirmed'
                  : `Private AI · ${location.evidence.model}`
              } · {
                Date.parse(location.evidence.staleAfter) > freshnessReference
                  ? `fresh until ${new Date(location.evidence.staleAfter).toLocaleDateString()}`
                  : 'stale; refresh pending'
              }
            </p>
            {location.inferenceEvidence && (
              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                Evidence: {location.inferenceEvidence}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            {location.errorCode === 'location_inference_uncertain'
              ? 'The descriptor did not support a reliable location. No location was guessed.'
              : location.errorCode
                ? 'Private location inference is unavailable. Transaction sync was not blocked.'
                : 'No normalized location evidence is available.'}
          </p>
        )}
      </section>
    </div>
  );
}
