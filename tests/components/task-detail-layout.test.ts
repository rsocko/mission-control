import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('task detail side-panel layouts', () => {
  it('keeps desktop project details in flow and allows project content to shrink', () => {
    const source = readSource('src/app/projects/[id]/page.tsx');

    expect(source).toContain("'min-h-0 min-w-0 flex-1'");
    expect(source).toContain("isGraphView ? 'flex flex-col overflow-y-auto' : 'space-y-6 overflow-y-auto'");
    expect(source).toContain('sm:relative sm:inset-auto sm:z-auto sm:h-full sm:min-w-0 sm:shrink');
  });

  it('provides My Day actions to project task details', () => {
    const source = readSource('src/app/projects/[id]/page.tsx');

    expect(source).toContain('isInMyDay={myDayTaskIds.has(selectedTaskId)}');
    expect(source).toContain('onToggleMyDay={() => myDayTaskIds.has(selectedTaskId)');
    expect(source).toContain('? void handleRemoveFromMyDay(selectedTaskId)');
    expect(source).toContain(': void handleAddToMyDay(selectedTaskId)');
  });

  it('lets dashboard, Matrix, and Today content resize around the task panel', () => {
    const dashboard = readSource('src/app/page.tsx');
    const matrix = readSource('src/app/matrix/page.tsx');
    const today = readSource('src/app/today/page.tsx');
    const todayMainPanel = readSource('src/components/today/TodayMainPanel.tsx');

    expect(dashboard).toContain('className="relative z-20 flex h-full min-w-0 shrink"');
    expect(dashboard).toContain("'invisible absolute inset-y-0 right-0 flex h-full'");
    expect(dashboard).toContain('className="flex min-w-0 flex-1 flex-col overflow-hidden p-6"');
    expect(matrix).toContain('className="hidden min-w-0 shrink sm:flex"');
    expect(matrix).toContain('mode={state.detailMode}');
    expect(matrix).toContain('onModeChange={actions.setDetailMode}');
    expect(matrix).toContain('taskSelection.toggleTask(task.id)');
    expect(matrix).toContain('mode="mobile"');
    expect(matrix).not.toContain('mode="dialog"');
    expect(today).not.toContain('w-[430px]');
    expect(todayMainPanel).toContain('hidden min-w-0 flex-1 overflow-y-auto');
  });
});
