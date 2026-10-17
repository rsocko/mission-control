import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('motion/react', () => {
  const motionProps = new Set([
    'animate',
    'initial',
    'transition',
    'variants',
    'whileHover',
    'whileTap',
  ]);
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: new Proxy({}, {
      get(_target, tag: string) {
        return (allProps: Record<string, unknown> & { children?: React.ReactNode }) => {
          const props = Object.fromEntries(
            Object.entries(allProps).filter(([key]) => key !== 'children' && !motionProps.has(key)),
          );
          return React.createElement(tag, props, allProps.children);
        };
      },
    }),
  };
});
vi.mock('@/lib/client-logger', () => ({
  settingsLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/app/settings/components/AIRunHistorySection', () => ({
  AIRunHistorySection: () => null,
}));
vi.mock('@/app/settings/components/ExecutionDestinationsSection', () => ({
  ExecutionDestinationsSection: () => null,
}));

import { AIProviderSection } from '@/app/settings/components/AIProviderSection';

describe('AI provider settings status', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/ai/models')) {
        return Response.json({ models: [] });
      }
      if (url === '/api/ai/provider') {
        return Response.json({
          provider: 'bifrost',
          model: 'azure/gpt-4o-mini',
          baseUrl: 'https://bifrost.test/v1',
          configured: true,
          savedConfig: {
            provider: 'bifrost',
            model: 'azure/gpt-4o-mini',
            baseUrl: 'https://bifrost.test/v1',
            hasApiKey: true,
          },
          providerHealth: [
            { route: 'azure-private', status: 'configured' },
            { route: 'bifrost-copilot', status: 'unknown' },
          ],
          entitlement: { status: 'managed', detail: 'Managed by Bifrost.' },
          quota: { status: 'unknown', detail: 'Quota has not been reported.' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  it('describes saved configuration without claiming the provider is connected', async () => {
    render(<AIProviderSection />);

    expect(await screen.findByText('AI Configured')).toBeInTheDocument();
    expect(screen.getByText(/Run a connection test to verify availability/)).toBeInTheDocument();
    expect(screen.queryByText('AI Connected')).not.toBeInTheDocument();
  });
});
