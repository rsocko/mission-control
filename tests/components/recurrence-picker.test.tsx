import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecurrencePicker from '@/components/ui/RecurrencePicker';
import {
  canonicalizeLegacyRecurrence,
  type CanonicalRecurrenceRuleV1,
} from '@/lib/recurrence/canonical';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function providerRule(support: 'supported' | 'lossy' | 'unsupported'): CanonicalRecurrenceRuleV1 {
  return canonicalizeLegacyRecurrence({
    recurrence: support === 'unsupported' ? 'provider-specific' : 'weekly',
    mode: 'schedule',
    startDate: '2026-09-21',
    timezone: 'UTC',
    seriesIdentity: {
      kind: 'connector',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'work',
      externalSeriesId: 'series-1',
      stability: 'provider',
    },
    source: {
      owner: 'connector',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'work',
      support: {
        status: support,
        reasons: support === 'supported' ? [] : ['provider_rule_lossy'],
      },
      raw: {},
    },
  });
}

describe('RecurrencePicker advanced controls', () => {
  it('renders a side-effect-free preview with loading and provider-write copy', async () => {
    let resolvePreview: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolvePreview = resolve;
    })));

    render(
      <RecurrencePicker
        value="daily"
        onChange={vi.fn()}
        startDate="2099-01-01"
        timezone="UTC"
        options={{ skipDates: [], catchUp: 'latest' }}
        onOptionsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Schedule details'));
    await waitFor(() => expect(screen.getByText('Calculating preview…')).toBeInTheDocument());

    resolvePreview?.(new Response(JSON.stringify({
      status: 'success',
      conditional: false,
      occurrences: [{ localDate: '2099-01-01', localTime: null, instant: null }],
    })));

    await screen.findByText(/Jan 1, 2099/);
    expect(screen.getByText(/Preview only/)).toHaveTextContent(
      'no tasks are created and nothing is sent to a provider',
    );
  });

  it('adds and removes skip dates with accessible controls', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      status: 'success',
      conditional: false,
      occurrences: [],
    })))));
    const onOptionsChange = vi.fn();

    const { rerender } = render(
      <RecurrencePicker
        value="weekly"
        onChange={vi.fn()}
        startDate="2026-09-21"
        timezone="UTC"
        options={{ skipDates: [], catchUp: 'latest' }}
        onOptionsChange={onOptionsChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Skip dates'), {
      target: { value: '2026-09-28' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onOptionsChange).toHaveBeenCalledWith({
      skipDates: ['2026-09-28'],
      catchUp: 'latest',
    });

    rerender(
      <RecurrencePicker
        value="weekly"
        onChange={vi.fn()}
        startDate="2026-09-21"
        timezone="UTC"
        options={{ skipDates: ['2026-09-28'], catchUp: 'latest' }}
        onOptionsChange={onOptionsChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove skipped date 2026-09-28' }));
    expect(onOptionsChange).toHaveBeenLastCalledWith({
      skipDates: [],
      catchUp: 'latest',
    });
  });

  it('shows lossy provider ownership and disables unsafe edits', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      status: 'unsupported',
      reasons: ['provider_rule_lossy'],
    })))));
    const rule = providerRule('lossy');

    render(
      <RecurrencePicker
        value="weekly"
        onChange={vi.fn()}
        controlState={{
          rule,
          owner: 'provider',
          support: 'lossy',
          reasons: ['provider_rule_lossy'],
          timezone: 'UTC',
          localTime: null,
        }}
        options={{ skipDates: [], catchUp: 'latest' }}
        onOptionsChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Task recurrence' })).toBeDisabled();
    expect(screen.getByText(/owned by the provider/)).toBeInTheDocument();
    expect(screen.getByText(/lost provider-specific detail/)).toBeInTheDocument();
    expect(screen.getByLabelText('Skip dates')).toBeDisabled();
  });

  it('shows a recoverable preview error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Projection unavailable' }), {
        status: 503,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'success',
        conditional: false,
        occurrences: [],
      })));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <RecurrencePicker
        value="daily"
        onChange={vi.fn()}
        options={{ skipDates: [], catchUp: 'latest' }}
        onOptionsChange={vi.fn()}
      />,
    );

    expect(await screen.findByText('Projection unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No occurrences fall within the next ten years.')).toBeInTheDocument();
  });

  it('uses responsive columns for upcoming occurrences in full and compact variants', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      status: 'success',
      conditional: false,
      occurrences: [{ localDate: '2099-01-01', localTime: null, instant: null }],
    })))));

    render(
      <RecurrencePicker
        value="daily"
        onChange={vi.fn()}
        variant="compact"
        options={{ skipDates: [], catchUp: 'latest' }}
        onOptionsChange={vi.fn()}
      />,
    );

    const occurrence = await screen.findByText(/2099/);
    expect(occurrence.closest('ol')).toHaveClass('grid', 'sm:grid-cols-2');
  });

  it('disables exception and policy edits while recurrence options are saving', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      status: 'success',
      conditional: false,
      occurrences: [],
    })))));

    render(
      <RecurrencePicker
        value="weekly"
        onChange={vi.fn()}
        options={{ skipDates: ['2026-09-28'], catchUp: 'latest' }}
        onOptionsChange={vi.fn()}
        optionsSaving
      />,
    );

    expect(screen.getByLabelText('Recurrence catch-up policy')).toBeDisabled();
    expect(screen.getByLabelText('Skip dates')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove skipped date 2026-09-28' })).toBeDisabled();
    expect(screen.getByText('Saving recurrence options…')).toBeInTheDocument();
  });
});
