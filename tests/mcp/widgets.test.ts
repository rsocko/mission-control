import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

type HostApp = {
  getContext: () => Promise<Record<string, unknown>>;
  callTool: ReturnType<typeof vi.fn>;
  ontheme: (callback: (theme: string) => void) => void;
  ondisplaymode?: (callback: (mode: string) => void) => void;
};

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function loadWidget(fileName: string, app: HostApp) {
  return loadOpenAIWidget(fileName, { app });
}

async function loadOpenAIWidget(fileName: string, openai: Record<string, unknown>) {
  const filePath = path.resolve(process.cwd(), 'public/mcp-widgets', fileName);
  const html = fs.readFileSync(filePath, 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  if (!scriptMatch) throw new Error(`No widget script found in ${fileName}`);

  const window = new Window({ url: 'https://widgets.example/' });
  window.document.write(html.replace(scriptMatch[0], ''));
  window.document.close();
  Object.assign(window, { openai });

  const context = vm.createContext({
    window,
    document: window.document,
    URL: window.URL,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(scriptMatch[1], context);
  await flush();
  return window;
}

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

async function loadMcpWidget(
  fileName: string,
  structuredContent: Record<string, unknown>,
  hostContext: Record<string, unknown>,
  options: {
    openLinkResult?: Record<string, unknown>;
    legacyApp?: HostApp;
  } = {},
) {
  const filePath = path.resolve(process.cwd(), 'public/mcp-widgets', fileName);
  const html = fs.readFileSync(filePath, 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  if (!scriptMatch) throw new Error(`No widget script found in ${fileName}`);

  const window = new Window({ url: 'https://widgets.example/' });
  const sentMessages: JsonRpcMessage[] = [];
  const dispatchHostMessage = (data: JsonRpcMessage) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: parentWindow });
    window.dispatchEvent(event);
  };
  const parentWindow = {
    postMessage: vi.fn((message: JsonRpcMessage) => {
      sentMessages.push(message);
      if (message.method === 'ui/initialize') {
        setTimeout(() => dispatchHostMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2026-01-26',
            hostInfo: { name: 'Test Host', version: '1.0.0' },
            hostCapabilities: {},
            hostContext,
          },
        }), 0);
      } else if (message.id) {
        setTimeout(() => dispatchHostMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: message.method === 'ui/open-link'
            ? (options.openLinkResult || {})
            : {},
        }), 0);
      } else if (message.method === 'ui/notifications/initialized') {
        setTimeout(() => dispatchHostMessage({
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: { structuredContent },
        }), 0);
      }
    }),
  };

  Object.defineProperty(window, 'parent', { value: parentWindow });
  if (options.legacyApp) {
    Object.assign(window, { openai: { app: options.legacyApp } });
  }
  window.document.write(html.replace(scriptMatch[0], ''));
  window.document.close();
  const context = vm.createContext({
    window,
    document: window.document,
    URL: window.URL,
    URLSearchParams: window.URLSearchParams,
    Map,
    Promise,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(scriptMatch[1], context);
  await flush();
  await flush();
  await flush();

  return {
    window,
    sentMessages,
    notify(method: string, params: Record<string, unknown>) {
      dispatchHostMessage({ jsonrpc: '2.0', method, params });
    },
  };
}

function click(window: Window, selector: string) {
  const element = window.document.querySelector(selector);
  if (!element) throw new Error(`Missing widget element: ${selector}`);
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

function cardContext() {
  return {
    data: {
      task: {
        id: 'task-1',
        title: 'Ship the widget',
        description: 'Verify reliable updates.',
        priority: 'high',
        status: 'todo',
        dueDate: null,
        projects: [{ name: 'Mission Control' }],
        tags: ['mcp'],
      },
      mcBaseUrl: 'https://mc.example',
    },
    theme: 'dark',
  };
}

function listTasks(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index + 1}`,
    title: `Task ${index + 1}`,
    priority: index === 0 ? 'critical' : 'medium',
    status: 'todo',
    dueDate: null,
  }));
}

describe('task card widget host contract', () => {
  it('updates successfully and uses safe Mission Control links', async () => {
    let themeListener: ((theme: string) => void) | undefined;
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Updated' }],
    });
    const window = await loadWidget('task-card.html', {
      getContext: async () => cardContext(),
      callTool,
      ontheme: callback => { themeListener = callback; },
    });

    expect(window.document.querySelector('#taskTitle')!.getAttribute('href'))
      .toBe('https://mc.example/tasks/task-1');
    themeListener!('light');
    expect(window.document.documentElement.classList.contains('light')).toBe(true);

    click(window, '#markDoneBtn');
    await flush();

    expect(callTool).toHaveBeenCalledWith('mc_update_task', {
      id: 'task-1',
      status: 'done',
    });
    expect(window.document.querySelector('#statusText')!.textContent).toBe('Done');
    expect(window.document.querySelector('#actionMessage')!.textContent).toContain('marked done');
  });

  it('shows pending state and rolls back a failed optimistic update', async () => {
    let rejectUpdate: (error: Error) => void = () => {};
    const callTool = vi.fn().mockImplementation(() => new Promise((_resolve, reject) => {
      rejectUpdate = reject;
    }));
    const window = await loadWidget('task-card.html', {
      getContext: async () => cardContext(),
      callTool,
      ontheme: () => {},
    });
    const button = window.document.querySelector('#markDoneBtn')!;

    click(window, '#markDoneBtn');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(window.document.querySelector('#statusText')!.textContent).toBe('Done');

    rejectUpdate(new Error('Network unavailable'));
    await flush();

    expect(button.hasAttribute('disabled')).toBe(false);
    expect(window.document.querySelector('#statusText')!.textContent).toBe('Todo');
    expect(window.document.querySelector('#actionMessage')!.textContent)
      .toContain('Network unavailable');
  });

  it('rolls back priority when the tool returns isError', async () => {
    const window = await loadWidget('task-card.html', {
      getContext: async () => cardContext(),
      callTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Write is disabled' }],
      }),
      ontheme: () => {},
    });

    click(window, '[data-priority="low"]');
    await flush();

    expect(window.document.querySelector('#priorityBadge')!.textContent).toBe('High');
    expect(window.document.querySelector('#actionMessage')!.textContent)
      .toContain('Write is disabled');
  });

  it('supports current M365 bridge fields and host-mediated links', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Updated' }] });
    const openExternal = vi.fn();
    const window = await loadOpenAIWidget('task-card.html', {
      toolOutput: cardContext().data,
      theme: 'light',
      callTool,
      openExternal,
    });

    expect(window.document.querySelector('#taskTitle')!.textContent).toBe('Ship the widget');
    expect(window.document.documentElement.classList.contains('light')).toBe(true);
    click(window, '#markDoneBtn');
    await flush();
    expect(callTool).toHaveBeenCalledWith('mc_update_task', {
      id: 'task-1',
      status: 'done',
    });

    click(window, '#openBtn');
    expect(openExternal).toHaveBeenCalledWith({
      href: 'https://mc.example/tasks/task-1',
    });

    window.dispatchEvent(new window.CustomEvent('openai:set_globals', {
      detail: {
        globals: {
          toolOutput: {
            ...cardContext().data,
            mcBaseUrl: 'javascript:alert(1)',
          },
        },
      },
    }));
    click(window, '#openBtn');
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('supports the standard MCP Apps lifecycle, tool calls, and links', async () => {
    const { window, sentMessages } = await loadMcpWidget(
      'task-card.html',
      cardContext().data,
      { theme: 'dark', displayMode: 'inline' },
    );

    expect(window.document.querySelector('#taskTitle')!.textContent).toBe('Ship the widget');
    expect(sentMessages[0]).toMatchObject({
      method: 'ui/initialize',
      params: { protocolVersion: '2026-01-26' },
    });

    click(window, '#markDoneBtn');
    await flush();
    expect(sentMessages).toContainEqual(expect.objectContaining({
      method: 'tools/call',
      params: {
        name: 'mc_update_task',
        arguments: { id: 'task-1', status: 'done' },
      },
    }));

    click(window, '#openBtn');
    expect(sentMessages).toContainEqual(expect.objectContaining({
      method: 'ui/open-link',
      params: { url: 'https://mc.example/tasks/task-1' },
    }));
  });

  it('does not expose preview task data when hosted output is missing', async () => {
    const { window } = await loadMcpWidget(
      'task-card.html',
      {},
      { theme: 'dark', displayMode: 'inline' },
    );

    expect(window.document.querySelector('#taskTitle')!.textContent).toBe('Loading task…');
    expect(window.document.querySelector('#markDoneBtn')!.hasAttribute('disabled')).toBe(true);
    expect(window.document.querySelector('#priorityBtn')!.hasAttribute('disabled')).toBe(true);
    expect(Array.from(window.document.querySelectorAll('.dropdown-item'))
      .every(item => item.hasAttribute('disabled'))).toBe(true);
    expect(window.document.querySelector('#openBtn')!.hasAttribute('hidden')).toBe(true);
    expect(window.document.body.textContent).not.toContain('Review PR #42');
  });
});

describe('task list widget host contract', () => {
  it('renders 50 linked tasks and responds to fullscreen and theme events', async () => {
    let themeListener: ((theme: string) => void) | undefined;
    let displayListener: ((mode: string) => void) | undefined;
    const window = await loadWidget('task-list.html', {
      getContext: async () => ({
        data: {
          tasks: listTasks(50),
          mcBaseUrl: 'https://mc.example',
          listTitle: 'Found 50 tasks',
        },
        theme: 'dark',
        displayMode: 'inline',
      }),
      callTool: vi.fn(),
      ontheme: callback => { themeListener = callback; },
      ondisplaymode: callback => { displayListener = callback; },
    });

    expect(window.document.querySelectorAll('.task-row')).toHaveLength(50);
    expect(window.document.querySelector('.task-row-title')!.getAttribute('href'))
      .toBe('https://mc.example/tasks/task-1');
    expect(window.document.querySelector('.priority-dot')!.getAttribute('aria-label'))
      .toBe('Priority: critical');
    expect(window.document.querySelector('[data-sort="priority"]')!.getAttribute('aria-pressed'))
      .toBe('true');
    themeListener!('light');
    displayListener!('fullscreen');
    expect(window.document.documentElement.classList.contains('light')).toBe(true);
    expect(window.document.documentElement.classList.contains('fullscreen')).toBe(true);
  });

  it('keeps controls pending and reports partial bulk failures for retry', async () => {
    const deferred = new Map<string, {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }>();
    const callTool = vi.fn((_name: string, args: { id: string }) => new Promise((resolve, reject) => {
      deferred.set(args.id, { resolve, reject });
    }));
    const window = await loadWidget('task-list.html', {
      getContext: async () => ({
        data: { tasks: listTasks(), mcBaseUrl: 'https://mc.example' },
        theme: 'dark',
      }),
      callTool,
      ontheme: () => {},
    });

    click(window, '.task-checkbox[data-id="task-1"]');
    click(window, '.task-checkbox[data-id="task-2"]');
    const bulkButton = window.document.querySelector('#bulkDoneBtn')!;
    click(window, '#bulkDoneBtn');

    expect(bulkButton.hasAttribute('disabled')).toBe(true);
    expect(window.document.querySelectorAll('.status-done')).toHaveLength(2);
    deferred.get('task-1')!.resolve({ content: [{ type: 'text', text: 'Updated' }] });
    deferred.get('task-2')!.reject(new Error('Task 2 is read-only'));
    await flush();

    expect(bulkButton.hasAttribute('disabled')).toBe(false);
    expect(window.document.querySelector('#actionMessage')!.textContent)
      .toContain('Updated 1 of 2. 1 failed');
    expect(window.document.querySelector('#actionMessage')!.textContent)
      .toContain('Retry the selected tasks');
    expect(window.document.querySelectorAll('.task-checkbox.checked')).toHaveLength(1);
    expect(window.document.querySelector('[data-id="task-1"] .row-status')!.textContent).toBe('Done');
    expect(window.document.querySelector('[data-id="task-2"] .row-status')!.textContent).toBe('Todo');
  });

  it('reports complete bulk success and clears selection', async () => {
    const window = await loadWidget('task-list.html', {
      getContext: async () => ({
        data: { tasks: listTasks(2), mcBaseUrl: 'https://mc.example' },
        theme: 'dark',
      }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Updated' }] }),
      ontheme: () => {},
    });
    click(window, '.task-checkbox[data-id="task-1"]');
    click(window, '.task-checkbox[data-id="task-2"]');

    click(window, '#bulkDoneBtn');
    await flush();

    expect(window.document.querySelectorAll('.status-done')).toHaveLength(2);
    expect(window.document.querySelectorAll('.task-checkbox.checked')).toHaveLength(0);
    expect(window.document.querySelector('#actionMessage')!.textContent)
      .toContain('Marked 2 tasks done');
  });

  it('supports current M365 task-list output and direct tool calls', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Updated' }] });
    const openExternal = vi.fn();
    const window = await loadOpenAIWidget('task-list.html', {
      toolOutput: {
        tasks: listTasks(2),
        mcBaseUrl: 'https://mc.example',
        listTitle: 'Scout tasks',
      },
      displayMode: 'fullscreen',
      callTool,
      openExternal,
    });

    expect(window.document.querySelector('#listTitle')!.textContent).toBe('Scout tasks');
    expect(window.document.documentElement.classList.contains('fullscreen')).toBe(true);
    click(window, '.task-checkbox[data-id="task-1"]');
    click(window, '#bulkDoneBtn');
    await flush();
    expect(callTool).toHaveBeenCalledWith('mc_update_task', {
      id: 'task-1',
      status: 'done',
    });

    click(window, '#viewAllLink');
    expect(openExternal).toHaveBeenCalledWith({
      href: 'https://mc.example/tasks',
    });
  });

  it('supports standard MCP Apps task-list results and authenticated tool calls', async () => {
    const { window, sentMessages } = await loadMcpWidget(
      'task-list.html',
      {
        tasks: listTasks(2),
        mcBaseUrl: 'https://mc.example',
        listTitle: 'Standard task list',
      },
      { theme: 'light', displayMode: 'fullscreen' },
    );

    expect(window.document.querySelector('#listTitle')!.textContent).toBe('Standard task list');
    expect(window.document.documentElement.classList.contains('fullscreen')).toBe(true);
    expect(window.document.querySelectorAll('.task-row')).toHaveLength(2);
    click(window, '.task-checkbox[data-id="task-1"]');
    click(window, '#bulkDoneBtn');
    await flush();

    expect(sentMessages).toContainEqual(expect.objectContaining({
      method: 'tools/call',
      params: {
        name: 'mc_update_task',
        arguments: { id: 'task-1', status: 'done' },
      },
    }));
  });
});

describe('triage summary widget host contract', () => {
  it('renders safe rich results and responds to theme, display, and sort controls', async () => {
    const { window, notify, sentMessages } = await loadMcpWidget(
      'triage-summary.html',
      {
          resourceUri: 'ui://mc/triage-summary',
          title: 'Saved research',
          total: 2,
          hasMore: false,
          mcBaseUrl: 'https://mc.example',
          items: [
            {
              id: 'triage-1',
              source: 'github',
              title: 'Safe repository',
              url: 'https://github.com/example/repo',
              summary: 'A useful saved repository.',
              score: 80,
              capturedAt: '2026-08-04T12:00:00.000Z',
              status: 'pending',
              contentType: 'repo',
              categories: ['development'],
              thumbnailUrl: 'https://mc.example/api/assets/thumbnails/repo.png',
            },
            {
              id: 'triage-2',
              source: 'web',
              title: '<img src=x onerror=alert(1)>',
              url: 'javascript:alert(1)',
              summary: '<script>alert(1)</script>',
              score: 99,
              capturedAt: '2026-08-05T12:00:00.000Z',
              status: 'snoozed',
              contentType: 'article',
              categories: [],
              thumbnailUrl: 'data:image/svg+xml,<svg onload=alert(1)>',
            },
          ],
      },
      { theme: 'dark', displayMode: 'inline' },
    );

    expect(sentMessages[0]).toMatchObject({
      method: 'ui/initialize',
      params: {
        protocolVersion: '2026-01-26',
        appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
      },
    });
    expect(sentMessages).toContainEqual(expect.objectContaining({
      method: 'ui/notifications/initialized',
    }));
    expect(window.document.querySelectorAll('.item')).toHaveLength(2);
    expect(window.document.querySelector('[data-id="triage-1"] .source-link')!.getAttribute('href'))
      .toBe('https://github.com/example/repo');
    expect(window.document.querySelector('[data-id="triage-2"] .source-link')).toBeNull();
    expect(window.document.querySelector('[data-id="triage-1"] img')!.getAttribute('src'))
      .toBe('https://mc.example/api/assets/thumbnails/repo.png');
    expect(window.document.querySelector('[data-id="triage-2"] img')).toBeNull();
    expect(window.document.querySelector('[data-id="triage-2"]')!.textContent)
      .toContain('<script>alert(1)</script>');
    expect(window.document.querySelector('#viewQueue')!.getAttribute('href'))
      .toBe('https://mc.example/triage');

    notify('ui/notifications/host-context-changed', {
      theme: 'light',
      displayMode: 'fullscreen',
    });
    expect(window.document.documentElement.classList.contains('light')).toBe(true);
    expect(window.document.documentElement.classList.contains('fullscreen')).toBe(true);

    click(window, '[data-sort="source"]');
    expect(window.document.querySelector('[data-sort="source"]')!.getAttribute('aria-pressed'))
      .toBe('true');
    expect(window.document.querySelector('.item')!.getAttribute('data-id')).toBe('triage-1');

    click(window, '[data-id="triage-1"] .source-link');
    expect(sentMessages).toContainEqual(expect.objectContaining({
      method: 'ui/open-link',
      params: { url: 'https://github.com/example/repo' },
    }));

    notify('ui/notifications/tool-result', {
      isError: true,
      content: [{ type: 'text', text: 'Triage unavailable' }],
    });
    expect(window.document.querySelector('[role="alert"]')!.textContent)
      .toContain('Triage search failed');
  });

  it('renders an accessible empty state without calling unregistered mutation tools', async () => {
    const { window, sentMessages } = await loadMcpWidget(
      'triage-summary.html',
      {
          resourceUri: 'ui://mc/triage-summary',
          title: 'No matches',
          total: 0,
          hasMore: false,
          mcBaseUrl: 'https://mc.example',
          items: [],
      },
      { theme: 'light', displayMode: 'inline' },
    );

    expect(window.document.querySelector('.empty')!.textContent)
      .toContain('No triage items match this search.');
    expect(window.document.querySelectorAll('button')).toHaveLength(3);
    expect(sentMessages.some(message => message.method === 'tools/call')).toBe(false);
  });

  it('renders cancellation and surfaces host-reported link failures', async () => {
    const { window, notify } = await loadMcpWidget(
      'triage-summary.html',
      {
        resourceUri: 'ui://mc/triage-summary',
        title: 'Saved research',
        total: 1,
        hasMore: false,
        items: [{
          id: 'triage-1',
          source: 'web',
          title: 'Source article',
          url: 'https://example.com/article',
          score: 50,
          capturedAt: '2026-08-05T12:00:00.000Z',
          status: 'pending',
          contentType: 'article',
          categories: [],
        }],
      },
      { theme: 'dark', displayMode: 'inline' },
      { openLinkResult: { isError: true } },
    );

    const link = window.document.querySelector('.source-link')!;
    click(window, '.source-link');
    await flush();
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.getAttribute('title')).toContain('could not open');

    notify('ui/notifications/tool-cancelled', {});
    expect(window.document.querySelector('[role="alert"]')!.textContent)
      .toContain('cancelled');
  });

  it('supports current M365 toolOutput and openExternal fields', async () => {
    const openExternal = vi.fn();
    const window = await loadOpenAIWidget('triage-summary.html', {
      toolOutput: {
        resourceUri: 'ui://mc/triage-summary',
        title: 'M365 triage',
        total: 1,
        hasMore: false,
        mcBaseUrl: 'https://mc.example',
        items: [{
          id: 'triage-1',
          source: 'web',
          title: 'Saved article',
          url: 'https://example.com/article',
          score: 88,
          capturedAt: '2026-08-05T12:00:00.000Z',
          status: 'pending',
          contentType: 'article',
          categories: [],
        }],
      },
      theme: 'light',
      displayMode: 'fullscreen',
      openExternal,
    });

    expect(window.document.querySelector('#title')!.textContent).toBe('M365 triage');
    expect(window.document.documentElement.classList.contains('light')).toBe(true);
    expect(window.document.documentElement.classList.contains('fullscreen')).toBe(true);
    click(window, '.source-link');
    expect(openExternal).toHaveBeenCalledWith({
      href: 'https://example.com/article',
    });
  });

  it('prefers the detected legacy bridge instead of waiting for JSON-RPC', async () => {
    const legacyApp: HostApp = {
      getContext: async () => ({
        data: {
          resourceUri: 'ui://mc/triage-summary',
          title: 'Legacy results',
          total: 0,
          hasMore: false,
          items: [],
        },
        theme: 'light',
      }),
      callTool: vi.fn(),
      ontheme: () => {},
    };
    const { window, sentMessages } = await loadMcpWidget(
      'triage-summary.html',
      {},
      {},
      { legacyApp },
    );

    expect(window.document.querySelector('#title')!.textContent).toBe('Legacy results');
    expect(window.document.documentElement.classList.contains('light')).toBe(true);
    expect(sentMessages.some(message => message.method === 'ui/initialize')).toBe(false);
  });
});
