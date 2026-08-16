import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCredentialSource } from '@/app/settings/components/triage-sources/useCredentialSource';
import {
  DocumentIntelligenceSourcePanel,
  GitHubSourcePanel,
  KarakeepSourcePanel,
  RedditSourcePanel,
  YouTubeSourcePanel,
} from '@/app/settings/components/triage-sources/CredentialSourcePanels';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCredentialSource', () => {
  it('gives every triage source the same save lifecycle and payload shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const onChanged = vi.fn();
    const { result } = renderHook(() => useCredentialSource({
      source: 'github',
      initialCredentials: { pat: '', username: '' },
      onChanged,
    }));

    act(() => {
      result.current.setCredential('pat', 'ghp_token');
      result.current.setCredential('username', 'octocat');
    });
    await act(async () => result.current.save());

    expect(result.current.status).toBe('saved');
    expect(fetch).toHaveBeenCalledWith('/api/triage/sources', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        source: 'github',
        credentials: { pat: 'ghp_token', username: 'octocat' },
      }),
    }));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('preserves configured secrets unless a replacement is entered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const { result } = renderHook(() => useCredentialSource({
      source: 'karakeep',
      initialCredentials: { url: 'https://keep.example', apiKey: '' },
      configured: true,
      optionalConfiguredKeys: ['apiKey'],
    }));

    await act(async () => result.current.save());

    expect(fetch).toHaveBeenCalledWith('/api/triage/sources', expect.objectContaining({
      body: JSON.stringify({
        source: 'karakeep',
        credentials: { url: 'https://keep.example' },
      }),
    }));
  });

  it('keeps an in-flight save busy and does not mark a newer draft saved', async () => {
    let resolveSave!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => {
      resolveSave = resolve;
    })));
    const onChanged = vi.fn();
    const { result } = renderHook(() => useCredentialSource({
      source: 'github',
      initialCredentials: { pat: '', username: '' },
      onChanged,
    }));

    act(() => result.current.setCredential('pat', 'first-token'));
    let save!: Promise<void>;
    act(() => {
      save = result.current.save();
    });
    await waitFor(() => expect(result.current.status).toBe('saving'));

    act(() => result.current.setCredential('pat', 'newer-token'));
    expect(result.current.status).toBe('saving');
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      resolveSave(new Response('{}', { status: 200 }));
      await save;
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.dirty).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('serializes queued saves and only marks the latest draft saved', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => {
      resolvers.push(resolve);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    const { result } = renderHook(() => useCredentialSource({
      source: 'github',
      initialCredentials: { pat: '', username: '' },
      onChanged,
    }));

    act(() => result.current.setCredential('pat', 'first-token'));
    let firstSave!: Promise<void>;
    act(() => {
      firstSave = result.current.save();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => result.current.setCredential('pat', 'latest-token'));
    let latestSave!: Promise<void>;
    act(() => {
      latestSave = result.current.save();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0](new Response('{}', { status: 200 }));
      await firstSave;
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe('saving');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/triage/sources', expect.objectContaining({
      body: JSON.stringify({
        source: 'github',
        credentials: { pat: 'latest-token', username: '' },
      }),
    }));

    await act(async () => {
      resolvers[1](new Response('{}', { status: 200 }));
      await latestSave;
    });

    expect(result.current.status).toBe('saved');
    expect(result.current.dirty).toBe(false);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('queues deletion behind an in-flight save and gives deletion final authority', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => {
      resolvers.push(resolve);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    const { result } = renderHook(() => useCredentialSource({
      source: 'github',
      initialCredentials: { pat: '', username: '' },
      onChanged,
    }));

    act(() => result.current.setCredential('pat', 'token-to-remove'));
    let save!: Promise<void>;
    act(() => {
      save = result.current.save();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    let remove!: Promise<void>;
    act(() => {
      remove = result.current.remove();
    });
    expect(result.current.status).toBe('deleting');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0](new Response('{}', { status: 200 }));
      await save;
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/triage/sources', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ source: 'github' }),
    }));
    expect(onChanged).not.toHaveBeenCalled();

    await act(async () => {
      resolvers[1](new Response('{}', { status: 200 }));
      await remove;
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.credentials).toEqual({ pat: '', username: '' });
    expect(result.current.dirty).toBe(false);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('rejects saves while deletion is in flight without issuing a POST', async () => {
    let resolveDelete!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => {
      resolveDelete = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCredentialSource({
      source: 'github',
      initialCredentials: { pat: 'configured-token', username: '' },
    }));

    let remove!: Promise<void>;
    act(() => {
      remove = result.current.remove();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe('deleting');

    await act(async () => {
      await expect(result.current.save()).rejects.toThrow(
        'Cannot save github credentials while removal is in progress',
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('deleting');

    await act(async () => {
      resolveDelete(new Response('{}', { status: 200 }));
      await remove;
    });
    expect(result.current.status).toBe('idle');
  });

  it('disables Save while a source deletion is pending', async () => {
    let resolveDelete!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => {
      resolveDelete = resolve;
    })));
    render(
      <GitHubSourcePanel
        configured
        connectedViaConnector={false}
        pat="configured-token"
        username=""
        onChanged={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('ghp_xxxxxxxxxxxxxxxxxxxx'), {
      target: { value: 'dirty-token' },
    });
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removeButtons[removeButtons.length - 1]);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());

    await act(async () => {
      resolveDelete(new Response('{}', { status: 200 }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('renders each source panel independently', () => {
    const onChanged = vi.fn();
    render(
      <>
        <GitHubSourcePanel configured={false} connectedViaConnector={false} pat="" username="" onChanged={onChanged} />
        <RedditSourcePanel configured={false} clientId="" clientSecret="" refreshToken="" username="" onChanged={onChanged} />
        <YouTubeSourcePanel configured={false} clientId="" clientSecret="" refreshToken="" onChanged={onChanged} />
        <KarakeepSourcePanel configured={false} configuredViaEnv={false} url="" onChanged={onChanged} />
        <DocumentIntelligenceSourcePanel autoSyncEnabled={false} intervalMinutes={15} saving={false} onToggle={vi.fn()} onIntervalChange={vi.fn()} />
      </>,
    );

    expect(screen.getByRole('heading', { name: 'GitHub Stars' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Reddit Saved' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'YouTube Playlists' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Karakeep' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'OWL' })).toBeInTheDocument();
  });
});
