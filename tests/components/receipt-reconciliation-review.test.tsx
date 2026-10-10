import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReceiptReconciliationReview } from '@/components/finance/ReceiptReconciliationReview';
import type {
  PaymentReviewItem,
  PaymentReviewPage,
} from '@/lib/receipt-reconciliation/contract';
import {
  ReceiptReconciliationClientError,
  type ReceiptReconciliationClient,
} from '@/lib/receipt-reconciliation/client';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

function review(id: string, payeeHint: string): PaymentReviewItem {
  return {
    contractVersion: '1.0',
    id,
    revision: 3,
    caseKind: 'ambiguous',
    state: 'open',
    active: true,
    attentionState: 'delivered',
    sourceAsOf: '2026-10-10T12:00:00Z',
    summary: { reasonCodes: ['close_candidates'] },
    obligation: {
      id: `obligation_${id}`,
      status: 'open',
      revision: 2,
      expectedAmountMinor: 10_000,
      currency: 'USD',
      completionSuggested: false,
    },
    evidence: {
      id: `evidence_${id}`,
      kind: 'bill',
      payeeHint,
      amountMinor: 10_000,
      currency: 'USD',
      evidenceDate: '2026-10-10',
      sourceSystem: 'tyrion_bill_match',
      sourceState: 'ambiguous',
      matchState: 'ambiguous',
      paymentStatus: 'ambiguous',
      confidence: 'medium',
      reasonCodes: ['close_candidates'],
      sourceAsOf: '2026-10-10T12:00:00Z',
      edgeState: 'proposed',
    },
    owlUrl: `https://owl.example/#/action-queue?obligation=${id}`,
    sourceActions: [{
      id: 'confirm',
      method: 'POST',
      url: `/api/mc/v1/payment-reconciliation-reviews/${id}/actions`,
      expectedRevision: 3,
    }],
  };
}

function page(items: PaymentReviewItem[]): PaymentReviewPage {
  return {
    contractVersion: '1.0',
    state: items.length ? 'ready' : 'empty',
    items,
    offset: 0,
    nextOffset: null,
    unavailableReason: null,
  };
}

function client(
  items = [review('review_one', 'Invented Utilities'), review('review_two', 'Invented Market')],
): ReceiptReconciliationClient & { list: ReturnType<typeof vi.fn>; act: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn().mockResolvedValue(page(items)),
    act: vi.fn(),
  };
}

describe('ReceiptReconciliationReview', () => {
  it('renders source-separated evidence without private identifiers', async () => {
    render(<ReceiptReconciliationReview client={client()} />);

    expect(await screen.findByRole('heading', { name: 'Invented Utilities' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Document evidence — OWL / Paperless' }))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Transaction evidence — Tyrion / Monarch' }))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mission Control decision' })).toBeInTheDocument();
    expect(screen.queryByText(/obligation_review/)).not.toBeInTheDocument();
    expect(screen.queryByText(/evidence_review/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in OWL/ })).toHaveAttribute(
      'href',
      expect.stringMatching(/^https:\/\/owl\.example\/#/),
    );
  });

  it('preserves row focus during keyboard queue navigation', async () => {
    render(<ReceiptReconciliationReview client={client()} />);
    const first = await screen.findByRole('button', { name: /Invented Utilities/ });
    const second = screen.getByRole('button', { name: /Invented Market/ });
    first.focus();

    fireEvent.keyDown(window, { key: 'j' });
    expect(second).toHaveFocus();
    expect(screen.getByRole('heading', { name: 'Invented Market' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(first).toHaveFocus();
  });

  it('uses optimistic revision, verifies refresh, and announces the result', async () => {
    const api = client([review('review_one', 'Invented Utilities')]);
    api.act.mockResolvedValue({
      contractVersion: '1.0',
      action: 'confirm',
      item: {
        ...review('review_one', 'Invented Utilities'),
        revision: 4,
        active: false,
        state: 'resolved',
        attentionState: 'settled',
        sourceActions: [],
      },
      sourceAcknowledgement: 'not_required',
      authoritativeReadBack: true,
      idempotent: false,
    });
    api.list
      .mockResolvedValueOnce(page([review('review_one', 'Invented Utilities')]))
      .mockResolvedValueOnce(page([]));
    render(<ReceiptReconciliationReview client={api} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm evidence' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Confirm evidence',
    }));

    await waitFor(() => expect(api.act).toHaveBeenCalledWith(
      'review_one',
      expect.objectContaining({
        action: 'confirm',
        expectedRevision: 3,
        evidenceId: 'evidence_review_one',
      }),
      expect.stringMatching(/^mc:payment-review:/),
    ));
    const emptyHeading = await screen.findByRole('heading', {
      name: 'No receipt exceptions need review',
    });
    await waitFor(() => expect(emptyHeading).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('verified by OWL');
  });

  it('loads OWL drift and announces retry-safe failures without exposing internals', async () => {
    const original = review('review_one', 'Invented Utilities');
    const current = { ...original, revision: 4, caseKind: 'conflict' as const };
    const api = client([original]);
    api.act.mockRejectedValue(new ReceiptReconciliationClientError(
      'This receipt review changed in OWL. The current state has been loaded.',
      409,
      'payment_reconciliation_revision_conflict',
      current,
    ));
    render(<ReceiptReconciliationReview client={api} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm evidence' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Confirm evidence',
    }));

    expect(await screen.findByText(/State: open · Revision 4/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('changed in OWL');
    expect(screen.queryByText('payment_reconciliation_revision_conflict')).not.toBeInTheDocument();
  });
});
