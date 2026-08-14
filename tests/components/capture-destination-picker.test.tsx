import React, { Activity, createContext, useContext } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CapturePageInner from '@/app/capture/CapturePageInner';

const mockFetch = vi.fn();
const enqueue = vi.fn();
let configuredDestination: {
  connectorType: string;
  connectorInstanceId?: string;
  sourceListId?: string;
  sourceListName?: string;
};
let destinationLoadFails: boolean;

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock('@/lib/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({
    enqueue,
    enqueueImage: vi.fn(),
    sync: vi.fn(),
  }),
}));

vi.mock('@/components/capture/VoiceButton', () => ({ VoiceButton: () => null }));
vi.mock('@/components/capture/ImageCaptureButton', () => ({ ImageCaptureButton: () => null }));
vi.mock('@/components/capture/ContextChips', () => ({ ContextChips: () => null }));
vi.mock('@/components/capture/RecentCaptures', () => ({ RecentCaptures: () => null }));
vi.mock('@/components/PendingSyncIndicator', () => ({ PendingSyncIndicator: () => null }));
vi.mock('@/components/ui/MobileSheet', () => ({ MobileSheet: () => null }));

vi.mock('@/components/ui/select', () => {
  const SelectContext = createContext<{
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  } | null>(null);

  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      disabled?: boolean;
      children: React.ReactNode;
    }) => (
      <SelectContext.Provider value={{ value, onValueChange, disabled }}>
        {children}
      </SelectContext.Provider>
    ),
    SelectTrigger: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
      const select = useContext(SelectContext);
      return (
        <button
          type="button"
          role="combobox"
          aria-controls="mock-select-options"
          aria-expanded="true"
          disabled={select?.disabled}
          {...props}
        >
          {select?.value}
          {children}
        </button>
      );
    },
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const select = useContext(SelectContext);
      return (
        <button
          type="button"
          role="option"
          aria-selected={select?.value === value}
          onClick={() => select?.onValueChange(value)}
        >
          {children}
        </button>
      );
    },
  };
});

beforeEach(() => {
  mockFetch.mockReset();
  enqueue.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('navigator', { ...navigator, onLine: true });
  window.localStorage.clear();
  configuredDestination = { connectorType: 'local' };
  destinationLoadFails = false;

  mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/settings/capture-destination' && init?.method !== 'PUT') {
      if (destinationLoadFails) throw new Error('Offline');
      return new Response(JSON.stringify({ destination: configuredDestination }));
    }
    if (url === '/api/features') {
      return new Response(JSON.stringify({
        taskDestinations: [{
          id: 'todo-1',
          type: 'microsoft-todo',
          name: 'Microsoft To Do',
          listSelectionMode: 'optional',
        }],
      }));
    }
    if (url === '/api/connectors/todo-1/lists') {
      return new Response(JSON.stringify({
        sourceLists: [{ sourceId: 'work-list', name: 'Work' }],
      }));
    }
    if (url === '/api/triage/capture/image') {
      return new Response(JSON.stringify({ maxBytes: 10_000_000 }));
    }
    return new Response('{}', { status: init?.method === 'POST' ? 201 : 200 });
  });
});

describe('mobile capture destination picker', () => {
  it('keeps an override for repeated captures, then resets it after leaving the page', async () => {
    const { rerender } = render(
      <Activity mode="visible">
        <CapturePageInner />
      </Activity>,
    );

    const sourcePicker = await screen.findByRole('combobox', { name: 'Destination source' });
    fireEvent.click(screen.getByRole('option', { name: 'Microsoft To Do' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Work' }));

    await waitFor(() => {
      const putRequests = mockFetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
      expect(putRequests).toHaveLength(0);
    });
    expect(JSON.parse(
      window.localStorage.getItem('mission-control:configured-capture-destination:v1') ?? '{}',
    )).toEqual(expect.objectContaining({
      destination: { connectorType: 'local' },
    }));

    fireEvent.change(screen.getByLabelText('Task or note'), {
      target: { value: 'Review capture flow' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to Work' }));

    await waitFor(() => {
      const postRequest = mockFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(postRequest).toBeDefined();
      expect(JSON.parse(String(postRequest?.[1]?.body))).toEqual(expect.objectContaining({
        title: 'Review capture flow',
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'todo-1',
        sourceListId: 'work-list',
        sourceListName: 'Work',
      }));
    });

    expect(sourcePicker).toHaveTextContent('todo-1');
    expect(screen.getByRole('combobox', { name: 'Destination list' })).toHaveTextContent('work-list');

    rerender(
      <Activity mode="hidden">
        <CapturePageInner />
      </Activity>,
    );
    rerender(
      <Activity mode="visible">
        <CapturePageInner />
      </Activity>,
    );

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Destination source' })).toHaveTextContent('local');
    });
  });

  it('waits for a changed configured destination before submitting a preserved draft', async () => {
    const { rerender } = render(
      <Activity mode="visible">
        <CapturePageInner />
      </Activity>,
    );

    await screen.findByRole('combobox', { name: 'Destination source' });
    fireEvent.change(screen.getByLabelText('Task or note'), {
      target: { value: 'Preserved draft' },
    });

    rerender(
      <Activity mode="hidden">
        <CapturePageInner />
      </Activity>,
    );
    configuredDestination = {
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
    };
    rerender(
      <Activity mode="visible">
        <CapturePageInner />
      </Activity>,
    );

    expect(screen.getByRole('button', { name: 'Save to Inbox' })).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Destination source' })).toHaveTextContent('todo-1');
    });
    expect(screen.getByRole('button', { name: 'Save to Microsoft To Do' })).toBeEnabled();
  });

  it('clears a destination error after a successful return to the page', async () => {
    destinationLoadFails = true;
    const { rerender } = render(
      <Activity mode="visible">
        <CapturePageInner />
      </Activity>,
    );

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Destinations are temporarily unavailable. Captures will save locally.',
    );

    rerender(
      <Activity mode="hidden">
        <CapturePageInner />
      </Activity>,
    );
    destinationLoadFails = false;
    rerender(
      <Activity mode="visible">
        <CapturePageInner />
      </Activity>,
    );

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('uses the cached configured destination during an offline cold start', async () => {
    window.localStorage.setItem('mission-control:configured-capture-destination:v1', JSON.stringify({
      destination: {
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'todo-1',
        sourceListId: 'work-list',
        sourceListName: 'Work',
      },
      source: {
        id: 'todo-1',
        type: 'microsoft-todo',
        name: 'Microsoft To Do',
        listSelectionMode: 'optional',
      },
    }));
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    mockFetch.mockRejectedValue(new Error('Offline'));

    render(<CapturePageInner />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Using your saved destination while destination data is unavailable.',
    );
    fireEvent.change(screen.getByLabelText('Task or note'), {
      target: { value: 'Queue remote task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to Work' }));

    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledWith('Queue remote task', undefined, {
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'todo-1',
        sourceListId: 'work-list',
        sourceListName: 'Work',
      });
    });
  });

  it('ignores a legacy sticky override and uses the configured default', async () => {
    window.localStorage.setItem('mission-control:capture-destination', JSON.stringify({
      destination: {
        connectorType: 'github',
        connectorInstanceId: 'github-1',
        sourceListId: 'rsocko/tyrion',
        sourceListName: 'rsocko/tyrion',
      },
      source: {
        id: 'github-1',
        type: 'github',
        name: 'GitHub',
        listSelectionMode: 'required',
      },
    }));

    render(<CapturePageInner />);

    const sourcePicker = await screen.findByRole('combobox', { name: 'Destination source' });
    expect(sourcePicker).toHaveTextContent('local');
    await waitFor(() => {
      expect(window.localStorage.getItem('mission-control:capture-destination')).toBeNull();
    });
  });
});
