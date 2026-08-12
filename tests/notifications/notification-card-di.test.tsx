/**
 * NotificationCard DI Rich Card Tests — Phase 2 (#717)
 *
 * Verifies that OWL notification cards render:
 * - Statement overdue progress bars
 * - EOB amount badges and patient responsibility
 * - Document type and priority indicators
 * - Preview links
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NotificationCard } from '@/components/notifications/NotificationCard';
import {
  registerDefaultNotificationProviders,
  resolveNotificationProvider,
} from '@/lib/notifications/providers';
import type { InboundNotification, NotificationItem } from '@/types';

// Mock motion/react to avoid animation issues in tests
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: Record<string, unknown>) => {
      const { layout, transition, initial, animate, exit, ...rest } = props;
      return <div {...rest}>{children as React.ReactNode}</div>;
    },
  },
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

function makeNotification(overrides?: Partial<NotificationItem>): NotificationItem {
  const receivedAt = new Date().toISOString();
  const notification: NotificationItem = {
    id: 'test-1',
    sourceId: 'test-src-1',
    connectorType: 'document-intelligence',
    connectorInstanceId: 'di-1',
    title: 'Test Notification',
    body: 'Test body text',
    level: 'action_needed',
    levelRank: 3,
    category: 'finance',
    state: 'unread',
    readState: 'unread',
    disposition: 'inbox',
    sourceState: 'active',
    syncState: 'synced',
    isActionable: true,
    receivedAt,
    sortAt: receivedAt,
    groupKey: null,
    actions: [],
    metadata: {},
    presentation: {},
    aiSuggestedActionId: null,
    ...overrides,
  };

  registerDefaultNotificationProviders();
  const resolved = resolveNotificationProvider({
    id: notification.id,
    sourceId: notification.sourceId,
    connectorType: notification.connectorType,
    connectorInstanceId: notification.connectorInstanceId,
    title: notification.title,
    body: notification.body || undefined,
    level: notification.level,
    category: notification.category,
    isRead: notification.state !== 'unread',
    isActionable: notification.isActionable,
    receivedAt: notification.receivedAt,
    hubProjectIds: [],
    tags: [],
    metadata: notification.metadata,
  } satisfies InboundNotification);

  return resolved
    ? {
        ...notification,
        title: resolved.presentation.title || notification.title,
        body: resolved.presentation.body ?? notification.body,
        presentation: resolved.presentation.presentation || notification.presentation,
      }
    : notification;
}

describe('NotificationCard — DI Rich Cards', () => {
  describe('Source identity and metadata', () => {
    it('shows a human-friendly source name and accessible brand identity', () => {
      const notification = makeNotification({
        connectorType: 'github-issues',
        category: 'pr_review',
      });

      const { container } = render(<NotificationCard notification={notification} />);

      expect(screen.getByText('GitHub')).toBeDefined();
      expect(container.querySelector('img[src="/icons/connectors/github.svg"]')).not.toBeNull();
      expect(screen.getByText('PR Review')).toBeDefined();
    });

    it('attributes document and money alerts to their owning agents', () => {
      const { container, rerender } = render(
        <NotificationCard notification={makeNotification()} />,
      );

      expect(screen.getByText('OWL')).toBeDefined();
      expect(Array.from(container.querySelectorAll('img')).map(image => image.getAttribute('src')))
        .toEqual(['/icons/agents/owl.svg']);

      rerender(
        <NotificationCard notification={makeNotification({ connectorType: 'finance' })} />,
      );

      expect(screen.getByText('Tyrion')).toBeDefined();
      expect(Array.from(container.querySelectorAll('img')).map(image => image.getAttribute('src')))
        .toContain('/icons/agents/tyrion.svg');
    });

    it('prefers an explicit source name from presentation metadata', () => {
      const notification = makeNotification({
        connectorType: 'custom-rest',
        presentation: { sourceName: 'Production n8n' },
      });

      render(<NotificationCard notification={notification} />);

      expect(screen.getByText('Production n8n')).toBeDefined();
      expect(screen.queryByText('Custom REST')).toBeNull();
    });

    it('renders configured presentation metadata chips', () => {
      const notification = makeNotification({
        connectorType: 'home-assistant',
        presentation: {
          metadataChips: [
            'Front door unlocked for 18m',
            { label: 'Status', value: 'Needs attention' },
          ],
        },
      });

      render(<NotificationCard notification={notification} />);

      expect(screen.getByText('Front door unlocked for 18m')).toBeDefined();
      expect(screen.getByText('Status:')).toBeDefined();
      expect(screen.getByText('Needs attention')).toBeDefined();
    });

    it('derives finance stat chips from structured metadata', () => {
      const notification = makeNotification({
        connectorType: 'monarch-money',
        metadata: { spent: 112, budget: 100, ratio: 1.12 },
      });

      render(<NotificationCard notification={notification} />);

      expect(screen.getByText('$12 over')).toBeDefined();
      expect(screen.getByText('112% used')).toBeDefined();
    });

    it('does not expose arbitrary metadata values', () => {
      const notification = makeNotification({
        metadata: { accessToken: 'super-secret-value' },
      });

      render(<NotificationCard notification={notification} />);

      expect(screen.queryByText('super-secret-value')).toBeNull();
    });

    it('ignores invalid numeric metadata and caps configured chips', () => {
      const notification = makeNotification({
        presentation: {
          metadataChips: ['One', 'Two', 'Three', 'Four', 'Five'],
        },
        metadata: {
          spent: Number.POSITIVE_INFINITY,
          budget: 100,
          ratio: Number.NaN,
        },
      });

      render(<NotificationCard notification={notification} />);

      expect(screen.getByText('Four')).toBeDefined();
      expect(screen.queryByText('Five')).toBeNull();
      expect(screen.queryByText(/\$∞|NaN/)).toBeNull();
    });
  });

  describe('Statement overdue notifications', () => {
    const statementNotification = makeNotification({
      title: 'Missing statement: First National Bank (2026-06)',
      body: 'Expected monthly statement from First National Bank not yet received.',
      metadata: {
        correspondent: 'First National Bank',
        correspondentId: 7,
        expectedPeriod: '2026-06',
        frequency: 'monthly',
        lastReceivedDate: '2026-05-15',
        daysOverdue: 20,
        previewUrl: 'http://paperless.example:8000/documents?correspondent=7',
      },
    });

    it('renders correspondent name', () => {
      render(<NotificationCard notification={statementNotification} />);
      expect(screen.getByText('First National Bank')).toBeDefined();
    });

    it('renders expected period', () => {
      render(<NotificationCard notification={statementNotification} />);
      expect(screen.getByText('2026-06')).toBeDefined();
    });

    it('renders days overdue', () => {
      render(<NotificationCard notification={statementNotification} />);
      expect(screen.getByText('20 days overdue')).toBeDefined();
    });

    it('renders frequency label', () => {
      render(<NotificationCard notification={statementNotification} />);
      expect(screen.getByText('monthly')).toBeDefined();
    });

    it('renders progress bar', () => {
      const { container } = render(<NotificationCard notification={statementNotification} />);
      const progressBar = container.querySelector('[style*="width"]');
      expect(progressBar).toBeDefined();
    });

    it('renders Paperless preview link', () => {
      render(<NotificationCard notification={statementNotification} />);
      const link = screen.getByText('View in Paperless-ngx');
      expect(link).toBeDefined();
      expect(link.closest('a')?.getAttribute('href')).toContain('paperless.example');
    });

    it('applies red color for severely overdue (>14 days)', () => {
      render(<NotificationCard notification={statementNotification} />);
      const overdueText = screen.getByText('20 days overdue');
      expect(overdueText.className).toContain('red');
    });

    it('applies amber color for moderately overdue (≤14 days)', () => {
      const modNotification = makeNotification({
        title: 'Missing statement: Test Bank (2026-06)',
        metadata: {
          correspondent: 'Test Bank',
          expectedPeriod: '2026-06',
          frequency: 'monthly',
          daysOverdue: 10,
        },
      });
      render(<NotificationCard notification={modNotification} />);
      const overdueText = screen.getByText('10 days overdue');
      expect(overdueText.className).toContain('amber');
    });
  });

  describe('EOB match notifications', () => {
    const eobNotification = makeNotification({
      title: 'Unmatched EOB: Dr. Smith — $350',
      body: 'EOB from Dr. Smith has no matching bill.',
      metadata: {
        provider: 'Dr. Smith',
        amount: 350.0,
        dateOfService: '2026-06-15',
        patientResponsibility: 125.0,
        documentUrl: 'http://paperless.example:8000/documents/99',
        previewUrl: 'http://paperless.example:8000/documents/99',
      },
    });

    it('renders provider name', () => {
      render(<NotificationCard notification={eobNotification} />);
      expect(screen.getByText('Dr. Smith')).toBeDefined();
    });

    it('renders amount badge', () => {
      render(<NotificationCard notification={eobNotification} />);
      expect(screen.getByText('350.00')).toBeDefined();
    });

    it('renders patient responsibility badge', () => {
      render(<NotificationCard notification={eobNotification} />);
      expect(screen.getByText('Patient: $125.00')).toBeDefined();
    });

    it('renders date of service', () => {
      render(<NotificationCard notification={eobNotification} />);
      expect(screen.getByText('2026-06-15')).toBeDefined();
    });

    it('renders preview link', () => {
      render(<NotificationCard notification={eobNotification} />);
      const link = screen.getByText('View in Paperless-ngx');
      expect(link).toBeDefined();
      expect(link.closest('a')?.getAttribute('href')).toContain('documents/99');
    });

    it('applies red style for high patient responsibility (>$100)', () => {
      render(<NotificationCard notification={eobNotification} />);
      const badge = screen.getByText('Patient: $125.00');
      expect(badge.className).toContain('red');
    });

    it('applies amber style for lower patient responsibility (≤$100)', () => {
      const lowNotification = makeNotification({
        title: 'Unmatched EOB: Dr. Jones — $100',
        metadata: {
          provider: 'Dr. Jones',
          amount: 100.0,
          dateOfService: '2026-06-10',
          patientResponsibility: 50.0,
          previewUrl: 'http://paperless.example:8000/documents/50',
        },
      });
      render(<NotificationCard notification={lowNotification} />);
      const badge = screen.getByText('Patient: $50.00');
      expect(badge.className).toContain('amber');
    });
  });

  describe('Non-DI notifications', () => {
    it('renders Finance insight rich content through the shared responsive card', () => {
      const notification = makeNotification({
        connectorType: 'finance-manager',
        title: 'Invented market purchase was unusually large',
        metadata: {
          notificationType: 'largeTransaction',
          occurrenceId: 'occurrence-invented-one',
          confidence: 'high',
          entityDisplayName: 'Invented market',
          observationPeriod: { start: '2026-08-09', end: '2026-08-09' },
          observedAmountMinor: -184000,
          absoluteDeltaMinor: 94000,
          percentageDeltaBasisPoints: 20444,
          currency: 'USD',
          primaryTarget: {
            system: 'monarch',
            targetKind: 'transaction',
            sourceRef: 'transaction-invented-one',
          },
        },
      });
      render(<NotificationCard notification={notification} onSelect={() => undefined} />);

      expect(screen.getByText('Invented market')).toBeDefined();
      expect(screen.getByText(/Amount: \$1,840\.00/)).toBeDefined();
      expect(screen.getByText('This is a spending notice, not a fraud determination.'))
        .toBeDefined();
      expect(screen.getByRole('button', {
        name: 'Open Invented market purchase was unusually large',
      })).toBeDefined();
    });

    it('does not render rich cards for non-DI connectors', () => {
      const notification = makeNotification({
        connectorType: 'github-issues',
        metadata: { someField: 'value' },
      });
      render(<NotificationCard notification={notification} />);
      expect(screen.queryByText('days overdue')).toBeNull();
      expect(screen.queryByText('Patient:')).toBeNull();
    });

    it('renders standard body text for non-DI connectors', () => {
      const notification = makeNotification({
        connectorType: 'microsoft-todo',
        body: 'Standard notification body',
        metadata: {},
      });
      render(<NotificationCard notification={notification} />);
      expect(screen.getByText('Standard notification body')).toBeDefined();
    });
  });

  describe('Compact mode', () => {
    it('hides rich card content in compact mode', () => {
      const notification = makeNotification({
        metadata: {
          correspondent: 'First National Bank',
          daysOverdue: 20,
          expectedPeriod: '2026-06',
          frequency: 'monthly',
        },
      });
      render(<NotificationCard notification={notification} compact />);
      expect(screen.queryByText('20 days overdue')).toBeNull();
    });
  });
});
