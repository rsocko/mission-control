import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageRow } from '@/components/ai/ChatMessageRow';
import { ToolCard } from '@/components/ai/ToolCard';
import { MobileChatBubble } from '@/components/houston/MobileChatBubble';
import type { ChatMessage, ToolPart } from '@/lib/ai/chatMessageFactory';
import { countCriticalAndHighTasks } from '@/lib/ai/taskSummary';
import {
  dayPlanResultSchema,
  taskMutationResultSchema,
  taskSearchResultSchema,
  taskSummaryResultSchema,
} from '@/lib/ai/toolResultSchemas';
import { TRIAGE_SUMMARY_RESOURCE_URI } from '@/lib/triage/summary-contract';

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('div', props, children),
    section: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('section', props, children),
    span: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('span', props, children),
  },
  useReducedMotion: () => true,
}));

afterEach(cleanup);

function toolPart(toolName: string, values: Partial<ToolPart> = {}): ToolPart {
  return {
    type: 'dynamic-tool',
    toolName,
    toolCallId: `call-${toolName}`,
    state: 'output-available',
    input: {},
    output: {},
    ...values,
  } as ToolPart;
}

function assistantMessage(part: ToolPart): ChatMessage {
  return {
    id: `message-${part.toolCallId}`,
    role: 'assistant',
    parts: [part],
    createdAt: '2026-08-04T12:00:00.000Z',
  };
}

describe('Houston task tool output guards', () => {
  it('counts critical and high tasks in the urgent summary aggregate', () => {
    expect(countCriticalAndHighTasks([
      { priority: 'critical' },
      { priority: 'high' },
      { priority: 'medium' },
      { priority: null },
    ])).toBe(2);
  });

  it('accepts the trusted output shapes', () => {
    expect(taskSearchResultSchema.safeParse([{ id: 'task-1', title: 'Ship cards', status: 'todo', priority: 'high' }]).success).toBe(true);
    expect(taskSummaryResultSchema.safeParse({
      total: 3,
      open: 2,
      overdue: 1,
      critical: 1,
      done: 1,
      bySource: { local: 2 },
      overdueItems: [{ id: 'task-1', title: 'Ship cards' }],
    }).success).toBe(true);
    expect(dayPlanResultSchema.safeParse({
      suggestions: [{ id: 'task-1', title: 'Ship cards', reason: 'overdue' }],
      totalOpen: 2,
      totalOverdue: 1,
      availableMinutes: 0,
    }).success).toBe(true);
    expect(taskMutationResultSchema.safeParse({
      success: true,
      taskId: 'task-1',
      title: 'Ship cards',
      status: 'done',
      priority: 'high',
      dueDate: null,
      source: 'local',
      sourceList: null,
    }).success).toBe(true);
  });

  it('rejects incomplete and fabricated task output', () => {
    expect(taskSearchResultSchema.safeParse([{ id: 'task-1', html: '<button>fake</button>' }]).success).toBe(false);
    expect(taskSummaryResultSchema.safeParse({ open: 'many', overdueItems: [] }).success).toBe(false);
    expect(taskMutationResultSchema.safeParse({ success: true, taskId: 'task-1' }).success).toBe(false);
    expect(taskMutationResultSchema.safeParse({
      success: true,
      taskId: 'task-1',
      title: 'Ship cards',
      status: 'done',
      priority: 'high',
      dueDate: 'not-a-date',
      source: 'local',
      sourceList: null,
      completedAt: 'also-not-a-date',
    }).success).toBe(false);
  });
});

describe('ToolCard native task results', () => {
  it('renders actionable search results and opens the existing task detail contract', () => {
    let selectedTaskId: string | undefined;
    const listener = (event: Event) => {
      selectedTaskId = (event as CustomEvent<{ taskId: string }>).detail.taskId;
      event.preventDefault();
    };
    window.addEventListener('mc:select-task', listener);

    render(<ToolCard part={toolPart('searchTasks', {
      input: { query: 'cards' },
      output: [{ id: 'task-1', title: 'Ship native cards', status: 'in_progress', priority: 'high', source: 'local' }],
    })} />);

    fireEvent.click(screen.getByRole('link', { name: 'Open task: Ship native cards' }));
    expect(selectedTaskId).toBe('task-1');
    window.removeEventListener('mc:select-task', listener);
  });

  describe('Houston triage widget rendering', () => {
    const triageResult = {
      resourceUri: TRIAGE_SUMMARY_RESOURCE_URI,
      title: 'Triage results',
      total: 1,
      hasMore: false,
      items: [{
        id: 'triage-1',
        source: 'github',
        title: 'Review MCP Apps',
        url: 'https://github.com/example/repo',
        summary: 'Evaluate the widget contract.',
        score: 91,
        capturedAt: '2026-08-04T12:00:00.000Z',
        status: 'pending',
        contentType: 'repo',
        categories: ['development'],
        thumbnailUrl: 'https://images.example/repo.png',
      }],
    };

    it('renders validated triage data in desktop and mobile Houston chat', () => {
      const part = toolPart('searchTriage', {
        output: {
          ...triageResult,
          total: 2,
          items: [
            ...triageResult.items,
            {
              ...triageResult.items[0],
              id: 'triage-2',
              source: 'youtube',
              title: 'A newer saved video',
              score: 70,
              capturedAt: '2026-08-05T12:00:00.000Z',
            },
          ],
        },
      });
      const desktop = render(<ChatMessageRow message={assistantMessage(part)} loading={false} />);

      expect(screen.getByLabelText('Triage summary')).toBeDefined();
      expect(screen.getByRole('link', { name: 'Open source: Review MCP Apps' })).toHaveAttribute(
        'href',
        'https://github.com/example/repo',
      );
      expect(screen.getByText('Score 91')).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'Newest' }));
      expect(screen.getByRole('button', { name: 'Newest' })).toHaveAttribute('aria-pressed', 'true');
      desktop.unmount();

      render(<MobileChatBubble message={assistantMessage(part)} loading={false} />);
      expect(screen.getByLabelText('Triage summary')).toBeDefined();
    });

    it('renders empty and error states', () => {
      const { rerender } = render(<ToolCard part={toolPart('searchTriage', {
        output: { ...triageResult, total: 0, items: [] },
      })} />);
      expect(screen.getByText('No triage items match this search.')).toBeDefined();

      rerender(<ToolCard part={toolPart('searchTriage', {
        state: 'output-error',
        errorText: 'Triage database unavailable',
      })} />);
      expect(screen.getByText('Triage database unavailable')).toBeDefined();
    });

    it('rejects model-provided HTML and unsafe URLs instead of rendering them', () => {
      render(<ToolCard part={toolPart('searchTriage', {
        output: {
          ...triageResult,
          items: [{
            ...triageResult.items[0],
            title: '<button>Run command</button>',
            url: 'javascript:alert(1)',
            thumbnailUrl: 'data:image/svg+xml,<svg onload=alert(1)>',
          }],
          html: '<iframe src="https://evil.example"></iframe>',
        },
      })} />);

      expect(screen.getByText('Houston received an unexpected tool result.')).toBeDefined();
      expect(screen.queryByText('Run command')).toBeNull();
      expect(document.querySelector('iframe')).toBeNull();
    });
  });

  it('preserves native modified-link navigation', () => {
    const listener = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener('mc:select-task', listener);
    render(<ToolCard part={toolPart('searchTasks', {
      output: [{ id: 'task-1', title: 'Open in another tab', status: 'todo', priority: 'medium' }],
    })} />);

    fireEvent.click(screen.getByRole('link', { name: 'Open task: Open in another tab' }), { ctrlKey: true });
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('mc:select-task', listener);
  });

  it('renders explicit empty, error, and malformed-result states', () => {
    const { rerender } = render(<ToolCard part={toolPart('searchTasks', { output: [] })} />);
    expect(screen.getByText('No matching tasks found.')).toBeDefined();

    rerender(<ToolCard part={toolPart('searchTasks', { output: { html: '<strong>model card</strong>' } })} />);
    expect(screen.getByText('Houston received an unexpected tool result.')).toBeDefined();
    expect(screen.queryByText('model card')).toBeNull();

    rerender(<ToolCard part={toolPart('searchTasks', { state: 'output-error', errorText: 'Search timed out' })} />);
    expect(screen.getByText('Search timed out')).toBeDefined();
  });

  it('labels a failed mutation consistently', () => {
    render(<ToolCard part={toolPart('completeTask', {
      output: { success: false, taskId: 'missing-task', error: 'Task not found.' },
    })} />);
    expect(screen.getByText('Update failed')).toBeDefined();
    expect(screen.getByText('Task not found.')).toBeDefined();
  });

  it('renders summaries, day plans, and mutation results with task references', () => {
    const { rerender } = render(<ToolCard part={toolPart('getTaskSummary', {
      output: {
        total: 4,
        open: 3,
        overdue: 1,
        critical: 1,
        done: 1,
        bySource: { local: 2, 'github-issues': 1 },
        overdueItems: [{ id: 'task-1', title: 'Fix overdue item', priority: 'critical', dueDate: '2026-08-01' }],
      },
    })} />);
    expect(screen.getByRole('link', { name: 'Open task: Fix overdue item' })).toBeDefined();
    expect(screen.getByText('github-issues')).toBeDefined();
    expect(screen.getByText('Critical/high')).toBeDefined();

    rerender(<ToolCard part={toolPart('suggestDayPlan', {
      output: {
        suggestions: [{ id: 'task-2', title: 'Plan focused work', priority: 'medium', reason: 'due today' }],
        totalOpen: 3,
        totalOverdue: 1,
      },
    })} />);
    expect(screen.getByRole('link', { name: 'Open task: Plan focused work' })).toBeDefined();

    rerender(<ToolCard part={toolPart('completeTask', {
      output: {
        success: true,
        taskId: 'task-3',
        title: 'Finish result card',
        status: 'done',
        priority: 'high',
        dueDate: null,
        source: 'local',
        sourceList: null,
        completedAt: '2026-08-04T12:00:00.000Z',
      },
    })} />);
    expect(screen.getByRole('link', { name: 'Open task: Finish result card' })).toBeDefined();
    expect(screen.getByText(/was marked complete/)).toBeDefined();
  });

  it('uses the same native card in desktop and mobile chat rendering', () => {
    const part = toolPart('searchTasks', {
      output: [{ id: 'task-1', title: 'Shared responsive card', status: 'todo', priority: 'medium' }],
    });
    const message = assistantMessage(part);

    const desktop = render(<ChatMessageRow message={message} loading={false} />);
    expect(screen.getByLabelText('Task search')).toBeDefined();
    expect(desktop.container.querySelector('.max-w-2xl')).not.toBeNull();
    desktop.unmount();

    const mobile = render(<MobileChatBubble message={message} loading={false} />);
    expect(screen.getByLabelText('Task search')).toBeDefined();
    expect(mobile.container.querySelector('.flex-1')).not.toBeNull();
  });

  it('renders the same bounded finance result through desktop and mobile ToolCard paths', () => {
    const part = toolPart('getHouseholdFinanceSummary', {
      output: {
        kind: 'household-finance-summary',
        period: { startDate: '2026-08-01', endDate: '2026-08-13' },
        missionControlCalculated: {
          totalSpending: 42.75,
          transactionCount: 1,
          byCategory: [{ category: 'Groceries', amount: 42.75, transactionCount: 1 }],
          byKid: [{ kidName: 'Avery', amount: 42.75, transactionCount: 1 }],
        },
        meta: {
          sourceAsOf: '2026-08-13T12:00:00.000Z',
          coverage: { start: '2026-08-01', end: '2026-08-13' },
          freshness: 'partial',
          truncated: true,
          deepLink: '/finance',
          provenance: [
            { kind: 'monarch-fact', label: 'Monarch facts via Tyrion Bridge', included: true },
            { kind: 'tyrion-derived', label: 'Tyrion-derived attribution/conclusions', included: true },
            { kind: 'mission-control-calculated', label: 'Mission Control-calculated aggregates', included: true },
          ],
        },
      },
    });
    const message = assistantMessage(part);
    const desktop = render(<ChatMessageRow message={message} loading={false} />);
    expect(screen.getByLabelText('Household finance summary')).toBeDefined();
    expect(screen.getByText('partial')).toBeDefined();
    expect(screen.getByText(/Monarch facts via Tyrion Bridge/)).toBeDefined();
    expect(screen.getByText(/result truncated/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open Finance' })).toHaveAttribute('href', '/finance');
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    desktop.unmount();

    render(<MobileChatBubble message={message} loading={false} />);
    expect(screen.getByLabelText('Household finance summary')).toBeDefined();
  });
});
