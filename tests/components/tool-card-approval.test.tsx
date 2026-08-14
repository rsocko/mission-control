import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessageRow } from '@/components/ai/ChatMessageRow';
import { ToolCard } from '@/components/ai/ToolCard';
import { MobileChatBubble } from '@/components/houston/MobileChatBubble';
import type { ChatMessage, ToolPart } from '@/lib/ai/chatMessageFactory';

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
      <div {...props}>{children}</div>
    ),
    section: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
      <section {...props}>{children}</section>
    ),
  },
  useReducedMotion: () => true,
}));

const approvalPart = {
  type: 'tool-assignFinanceTransactionKid',
  toolCallId: 'invented-call',
  state: 'approval-requested',
  input: {
    transactionRef: `txn_${'a'.repeat(43)}`,
    expected: {
      date: '2026-08-13',
      amount: -12.34,
      merchant: 'Invented Market',
      category: 'Groceries',
      kidName: null,
      stateToken: `state_${'b'.repeat(43)}`,
    },
    kidName: 'Avery',
  },
  approval: {
    id: 'invented-approval',
    signature: 'invented-signature',
  },
} as ToolPart;

const approvalMessage: ChatMessage = {
  id: 'invented-message',
  role: 'assistant',
  parts: [approvalPart],
};

describe('finance mutation approval cards', () => {
  it('renders the shared accessible approval controls on desktop and mobile', () => {
    const desktop = render(
      <ChatMessageRow
        message={approvalMessage}
        loading={false}
        onApprovalResponse={vi.fn()}
      />,
    );
    expect(desktop.getByRole('region', {
      name: 'Assign transaction to household member approval required',
    })).toBeInTheDocument();
    expect(desktop.getByRole('button', {
      name: 'Approve assign transaction to household member',
    })).toBeEnabled();
    expect(desktop.getByRole('button', {
      name: 'Deny assign transaction to household member',
    })).toBeEnabled();
    desktop.unmount();

    const mobile = render(
      <MobileChatBubble
        message={approvalMessage}
        loading={false}
        onApprovalResponse={vi.fn()}
      />,
    );
    expect(mobile.getByRole('region', {
      name: 'Assign transaction to household member approval required',
    })).toBeInTheDocument();
    expect(mobile.getByRole('button', {
      name: 'Approve assign transaction to household member',
    })).toBeEnabled();
    expect(mobile.getByRole('button', {
      name: 'Deny assign transaction to household member',
    })).toBeEnabled();
  });

  it('disables both decisions while submitting and prevents duplicate approval', async () => {
    let resolve: (() => void) | undefined;
    const pending = new Promise<void>(done => {
      resolve = done;
    });
    const onApprovalResponse = vi.fn(() => pending);
    render(
      <ToolCard part={approvalPart} onApprovalResponse={onApprovalResponse} />,
    );

    const approve = screen.getByRole('button', {
      name: 'Approve assign transaction to household member',
    });
    fireEvent.click(approve);
    fireEvent.click(approve);

    expect(onApprovalResponse).toHaveBeenCalledTimes(1);
    expect(approve).toBeDisabled();
    expect(screen.getByRole('button', {
      name: 'Deny assign transaction to household member',
    })).toBeDisabled();
    expect(screen.getByText('Submitting...')).toBeInTheDocument();

    resolve?.();
    await waitFor(() => expect(approve).toBeEnabled());
  });

  it('renders denied, failed, replayed, and applying states without new controls', () => {
    const { rerender } = render(
      <ToolCard
        part={{
          ...approvalPart,
          state: 'output-denied',
          approval: { ...approvalPart.approval, approved: false },
        } as ToolPart}
      />,
    );
    expect(screen.getByText('No finance mutation was executed.')).toBeInTheDocument();

    rerender(
      <ToolCard
        part={{
          ...approvalPart,
          state: 'output-error',
          errorText: 'The finance mutation could not be completed.',
        } as ToolPart}
      />,
    );
    expect(screen.getByText('The finance mutation could not be completed.')).toBeInTheDocument();

    rerender(
      <ToolCard
        part={{
          ...approvalPart,
          state: 'input-available',
        } as ToolPart}
      />,
    );
    expect(screen.getByText('Applying approved kid assignment...')).toBeInTheDocument();

    rerender(
      <ToolCard
        part={{
          ...approvalPart,
          state: 'output-available',
          output: {
            kind: 'finance-kid-assignment',
            status: 'updated',
            missionControlConfirmed: { kidName: 'Avery' },
            replayed: true,
            provenance: [
              { kind: 'monarch-fact', label: 'Monarch facts via Tyrion Bridge', included: true },
              { kind: 'tyrion-derived', label: 'Tyrion-derived attribution/conclusions', included: true },
              { kind: 'mission-control-calculated', label: 'Mission Control-calculated aggregates', included: false },
              { kind: 'mission-control-confirmed', label: 'Mission Control-confirmed decision', included: true },
            ],
          },
        } as ToolPart}
      />,
    );
    expect(screen.getByText('Assigned to Avery (already applied)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });
});
