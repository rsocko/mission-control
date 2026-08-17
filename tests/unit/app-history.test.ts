import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_HISTORY_STATE_KEY,
  currentAppHistoryDetail,
  getAppHistorySnapshot,
  installAppHistory,
  pushAppHistoryDetail,
} from '@/lib/navigation/app-history';

let uninstall: (() => void) | null = null;

describe('app history manager', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    uninstall = installAppHistory();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    window.history.replaceState({}, '', '/');
  });

  it('marks the launch entry as a safe back boundary', () => {
    expect(window.history.state[APP_HISTORY_STATE_KEY]).toMatchObject({
      position: 0,
    });
    expect(getAppHistorySnapshot()).toMatchObject({
      canGoBack: false,
      canGoForward: false,
    });
  });

  it('tracks pushes and preserves the position across replacements', () => {
    window.history.pushState({ route: 'today' }, '', '/today');
    expect(getAppHistorySnapshot()).toMatchObject({
      canGoBack: true,
      canGoForward: false,
      position: 1,
      maxPosition: 1,
    });

    window.history.replaceState({ route: 'today-filtered' }, '', '/today?filter=open');
    expect(window.history.state).toMatchObject({
      route: 'today-filtered',
      [APP_HISTORY_STATE_KEY]: {
        position: 1,
      },
    });
    expect(getAppHistorySnapshot().position).toBe(1);
  });

  it('enables Forward after returning to an owned entry', async () => {
    window.history.pushState({}, '', '/today');
    window.history.back();

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(getAppHistorySnapshot()).toMatchObject({
      canGoBack: false,
      canGoForward: true,
      position: 0,
      maxPosition: 1,
    });
  });

  it('truncates the tracked Forward branch after a new push', async () => {
    window.history.pushState({}, '', '/today');
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/'));

    window.history.pushState({}, '', '/projects');

    expect(getAppHistorySnapshot()).toMatchObject({
      canGoBack: true,
      canGoForward: false,
      position: 1,
      maxPosition: 1,
    });
  });

  it('does not leak detail ownership into later route entries', () => {
    pushAppHistoryDetail('/today?taskId=task-1', {
      kind: 'detail',
      param: 'taskId',
      parentHref: '/today',
    });
    expect(currentAppHistoryDetail()?.param).toBe('taskId');

    window.history.pushState({ ...window.history.state }, '', '/projects');

    expect(currentAppHistoryDetail()).toBeNull();
  });
});
