import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReconciliationReview } from '@/components/scout/ReconciliationReview';

const suggestion = {
  id: 'suggestion-1',
  taskId: 'task-1',
  taskTitle: 'Send synthetic follow-up',
  taskPriority: 'medium',
  taskDueDate: null,
  action: 'suggest-complete' as const,
  confidence: 0.94,
  evidence: [{
    signalId: 'signal-1',
    sourceType: 'email',
    kind: 'requester-confirmed-resolved',
    occurredAt: '2026-08-05T11:00:00.000Z',
    summary: 'Requester confirmed the synthetic item is resolved',
    sourceRefHash: '0'.repeat(64),
  }],
  policyReason: 'Autonomous completion requires confirmation',
  payloadHash: 'a'.repeat(64),
  proposedEffect: { taskId: 'task-1', status: 'done' },
  createdAt: '2026-08-05T12:00:00.000Z',
  expiresAt: '2026-08-19T12:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Scout reconciliation review', () => {
  it('shows confidence, minimal evidence, and actionable review controls', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ suggestions: [suggestion], count: 1 }))
      .mockResolvedValueOnce(Response.json({ status: 'accepted' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReconciliationReview />);

    expect(await screen.findByText('Send synthetic follow-up')).toBeInTheDocument();
    expect(screen.getByText('94% confidence')).toBeInTheDocument();
    expect(screen.getByText(/Requester confirmed the synthetic item is resolved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Never auto-complete' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/scout/reconciliation/suggestions/suggestion-1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'accept', payloadHash: suggestion.payloadHash }),
      }),
    ));
    expect(await screen.findByText('No suggestions need review')).toBeInTheDocument();
  });

  it('keeps API failures visible and does not remove the suggestion', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ suggestions: [suggestion], count: 1 }))
      .mockResolvedValueOnce(Response.json({ error: 'The suggestion changed' }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReconciliationReview />);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The suggestion changed');
    expect(screen.getByText('Send synthetic follow-up')).toBeInTheDocument();
  });
});
