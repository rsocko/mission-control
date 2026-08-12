import { describe, expect, it } from 'vitest';
import { restrictToolsAfterTriage } from '@/lib/ai/tool-safety';

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
});
