import { describe, expect, it } from 'vitest';
import {
  excludeFinanceMutations,
  restrictToolsAfterTriage,
} from '@/lib/ai/tool-safety';

describe('Houston tool safety', () => {
  it('allows only read-only follow-up tools after untrusted triage content is returned', () => {
    expect(restrictToolsAfterTriage({
      steps: [
        {
          toolResults: [{
            toolName: 'searchTasks',
          }],
        },
        {
          toolResults: [
            { toolName: 'getNotifications' },
            { toolName: 'searchTriage' },
          ],
        },
      ],
    })).toEqual({
      activeTools: expect.arrayContaining([
        'searchTasks',
        'getNotifications',
        'searchTriage',
      ]),
    });

    const { activeTools } = restrictToolsAfterTriage({
      steps: [{
        toolResults: [{ toolName: 'searchTriage' }],
      }],
    })!;
    expect(activeTools).not.toContain('completeTask');
    expect(activeTools).not.toContain('updateTaskPriority');
    expect(activeTools).not.toContain('updateTaskEffort');
    expect(activeTools).not.toContain('intakeDocument');
    expect(activeTools).not.toContain('getHouseholdFinanceSummary');
    expect(activeTools).not.toContain('searchFinanceTransactions');
    expect(activeTools).not.toContain('getPendingFinanceExceptions');
    expect(activeTools).not.toContain('getKidSpending');
    expect(activeTools).not.toContain('getFinanceObligations');
    expect(activeTools).not.toContain('getFinanceConnectorHealth');
    expect(activeTools).not.toContain('assignFinanceTransactionKid');
    expect(activeTools).not.toContain('updateFinanceTransactionCategory');
  });

  it('keeps only the six finance reads available after finance intent preceded triage', () => {
    const { activeTools } = restrictToolsAfterTriage({
      steps: [
        { toolResults: [{ toolName: 'getFinanceConnectorHealth' }] },
        { toolResults: [{ toolName: 'searchTriage' }] },
      ],
    })!;
    expect(activeTools).toEqual(expect.arrayContaining([
      'getHouseholdFinanceSummary',
      'searchFinanceTransactions',
      'getPendingFinanceExceptions',
      'getKidSpending',
      'getFinanceObligations',
      'getFinanceConnectorHealth',
    ]));
    expect(activeTools).not.toContain('assignFinanceTransactionKid');
    expect(activeTools).not.toContain('updateFinanceTransactionCategory');
  });

  it('leaves tools available when no triage content was consumed', () => {
    expect(restrictToolsAfterTriage({
      steps: [{
        toolResults: [{
          toolName: 'searchTasks',
        }],
      }],
    })).toBeUndefined();
  });

  it('disables both finance mutations while an approval response is resumed', () => {
    expect(excludeFinanceMutations([
      'searchTasks',
      'getHouseholdFinanceSummary',
      'assignFinanceTransactionKid',
      'updateFinanceTransactionCategory',
    ])).toEqual([
      'searchTasks',
      'getHouseholdFinanceSummary',
    ]);
  });

  it('allows only reads after persisted finance content enters model context', () => {
    const { activeTools } = restrictToolsAfterTriage({
      steps: [{
        toolResults: [{ toolName: 'searchFinanceTransactions' }],
      }],
    })!;
    expect(activeTools).toEqual(expect.arrayContaining([
      'searchTasks',
      'searchTriage',
      'searchFinanceTransactions',
      'getFinanceConnectorHealth',
    ]));
    expect(activeTools).not.toContain('completeTask');
    expect(activeTools).not.toContain('updateTaskPriority');
    expect(activeTools).not.toContain('intakeDocument');
    expect(activeTools).not.toContain('assignFinanceTransactionKid');
    expect(activeTools).not.toContain('updateFinanceTransactionCategory');
  });
});
