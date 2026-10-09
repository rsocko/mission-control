import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayeeDocumentReview } from '@/components/finance/PayeeDocumentReview';
import {
  PayeeDocumentReviewClientError,
  type PayeeDocumentReviewClient,
} from '@/lib/payee-document-review/client';
import type {
  PayeeDocumentReviewItem,
  PayeeDocumentReviewSnapshot,
} from '@/lib/payee-document-review/contract';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock('next/image', () => ({
  default: ({ alt }: { alt?: string }) => <span role="img" aria-label={alt || 'agent icon'} />,
}));

const candidate: PayeeDocumentReviewItem = {
  candidateId: 'owl-candidate-17',
  pattern: {
    displayName: 'Invented Utilities',
    activity: 'active',
    classification: 'recurring-variable',
    observationCount: 8,
    observationWindow: {
      firstObservedOn: '2026-01-12',
      lastObservedOn: '2026-08-12',
    },
    intervalEvidence: {
      sampleCount: 7,
      medianDays: 30,
      minimumDays: 28,
      maximumDays: 32,
    },
    confidence: 0.86,
    basis: ['interval-cluster'],
    provenance: {
      transactionHistory: true,
      monarchRecurring: true,
    },
    monarchConfirmedRecurring: {
      active: true,
      cadence: 'monthly',
    },
  },
  documentPolicy: {
    status: 'unreviewed',
    correspondentRef: null,
    correspondentName: null,
    expectationSummary: null,
    owlPolicyUrl: 'https://owl.example/reviews/owl-candidate-17',
  },
};

const readySnapshot: PayeeDocumentReviewSnapshot = {
  contractVersion: '1',
  state: 'ready',
  sourceAsOf: '2026-08-13T10:00:00.000Z',
  items: [candidate],
  correspondents: [
    { correspondentRef: '41', name: 'Invented Utility Company' },
    { correspondentRef: '52', name: 'Invented Insurance Company' },
  ],
  unavailableReason: null,
};

function clientFor(
  snapshot: PayeeDocumentReviewSnapshot,
  decide: PayeeDocumentReviewClient['decide'] = vi.fn(async () => ({
    candidateId: candidate.candidateId,
    acknowledged: true as const,
    documentPolicy: {
      ...candidate.documentPolicy,
      status: 'mapped' as const,
      correspondentRef: '41',
    },
  })),
): PayeeDocumentReviewClient {
  return {
    load: vi.fn(async () => snapshot),
    decide,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PayeeDocumentReview', () => {
  it('separates Tyrion evidence from OWL policy without rendering a ledger', async () => {
    render(<PayeeDocumentReview client={clientFor(readySnapshot)} />);

    expect(await screen.findByRole('heading', { name: 'Payee document review' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Financial pattern evidence' })).toBeInTheDocument();
    expect(screen.getByText('Read-only from Tyrion')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Document policy' })).toBeInTheDocument();
    expect(screen.getByText('Owned by OWL and Paperless')).toBeInTheDocument();
    expect(screen.getByText(/Repeated financial activity does not establish a document cadence/)).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.queryByText(/transaction id|account number|raw transaction/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Edit detailed expectation policy in OWL/ }))
      .toHaveAttribute('href', 'https://owl.example/reviews/owl-candidate-17');
  });

  it('maps a candidate through the injected adapter and announces success', async () => {
    const decide = vi.fn(async () => ({
      candidateId: candidate.candidateId,
      acknowledged: true as const,
      documentPolicy: {
        ...candidate.documentPolicy,
        status: 'mapped' as const,
        correspondentRef: '41',
      },
    }));
    render(<PayeeDocumentReview client={clientFor(readySnapshot, decide)} />);

    const select = await screen.findByLabelText('Paperless correspondent');
    fireEvent.change(select, { target: { value: '41' } });
    fireEvent.click(screen.getByRole('button', { name: 'Map to correspondent' }));

    await waitFor(() => expect(decide).toHaveBeenCalledWith({
      candidateId: 'owl-candidate-17',
      decision: 'map-correspondent',
      correspondentRef: '41',
    }));
    expect(await screen.findByText('Paperless correspondent mapping saved.')).toBeInTheDocument();
    expect(screen.getAllByText('Invented Utility Company').length).toBeGreaterThan(0);
  });

  it('requires confirmation before recording that no documents are expected', async () => {
    const decide = vi.fn(async () => ({
      candidateId: candidate.candidateId,
      acknowledged: true as const,
      documentPolicy: {
        ...candidate.documentPolicy,
        status: 'not-expected' as const,
      },
    }));
    render(<PayeeDocumentReview client={clientFor(readySnapshot, decide)} />);

    fireEvent.click(await screen.findByRole('button', { name: 'No documents expected' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      "This does not change Tyrion's financial pattern evidence.",
    );
    expect(decide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Mark no documents expected' }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith({
      candidateId: 'owl-candidate-17',
      decision: 'no-documents-expected',
    }));
  });

  it.each([
    {
      name: 'unavailable',
      snapshot: {
        ...readySnapshot,
        state: 'unavailable' as const,
        items: [],
        correspondents: [],
        unavailableReason: 'OWL is upgrading.',
      },
      expected: 'Cross-domain review is not connected',
    },
    {
      name: 'empty',
      snapshot: {
        ...readySnapshot,
        state: 'empty' as const,
        items: [],
      },
      expected: 'No payees need document review',
    },
  ])('renders the $name state', async ({ snapshot, expected }) => {
    render(<PayeeDocumentReview client={clientFor(snapshot)} />);
    expect(await screen.findByRole('heading', { name: expected })).toBeInTheDocument();
  });

  it('renders a forbidden state without offering a retry loop', async () => {
    const client: PayeeDocumentReviewClient = {
      load: vi.fn(async () => {
        throw new PayeeDocumentReviewClientError('Forbidden', 403);
      }),
      decide: vi.fn(),
    };
    render(<PayeeDocumentReview client={client} />);

    expect(await screen.findByText(
      'Payee document review is restricted to the parent administrator.',
    )).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
