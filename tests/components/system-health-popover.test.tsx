import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectorHealthIssue } from '@/components/layout/AppShell';

describe('system health popover', () => {
  it('shows the specific connector degradation reason', () => {
    render(
      <ConnectorHealthIssue
        connector={{
          id: 'github-1',
          type: 'github-issues',
          name: 'GitHub',
          status: 'degraded',
          message: 'GitHub relationship verification was interrupted',
          lastSyncAt: '2026-09-08T17:29:18.325Z',
        }}
      />,
    );

    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('GitHub relationship verification was interrupted')).toBeInTheDocument();
  });
});
