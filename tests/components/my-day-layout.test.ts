import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/components/today/TodayMainPanel.tsx'),
  'utf8',
);
const mobileSource = readFileSync(
  resolve(process.cwd(), 'src/components/today/MobileTodayList.tsx'),
  'utf8',
);
const timelineSource = readFileSync(
  resolve(process.cwd(), 'src/components/today/InteractiveTimeline.tsx'),
  'utf8',
);
const pageSource = readFileSync(
  resolve(process.cwd(), 'src/app/today/page.tsx'),
  'utf8',
);
const sidebarSource = readFileSync(
  resolve(process.cwd(), 'src/components/today/TodaySidebar.tsx'),
  'utf8',
);

describe('My Day desktop layout', () => {
  it('labels summary metrics by what they count', () => {
    expect(source).toContain('uppercase">Open</p>');
    expect(source).toContain('uppercase">Done</p>');
    expect(source).toContain('uppercase">Cancelled</p>');
    expect(source).toContain('uppercase">Scheduled Time</p>');
    expect(source).not.toContain('uppercase">Tasks</p>');
  });

  it('places task controls after the planning widgets and with the open task list', () => {
    const focusPanel = source.indexOf('<Focus3Panel');
    const routines = source.indexOf('<TodayRoutinesSection');
    const openTasks = source.indexOf('Open Tasks ({activeItems.length})');
    const taskFilter = source.indexOf('<TaskKeywordFilter');
    const taskList = source.indexOf('<DndContext');

    expect(focusPanel).toBeGreaterThan(-1);
    expect(routines).toBeGreaterThan(focusPanel);
    expect(openTasks).toBeGreaterThan(routines);
    expect(taskFilter).toBeGreaterThan(openTasks);
    expect(taskList).toBeGreaterThan(taskFilter);
    expect(source).not.toContain('Today&apos;s Focus ({activeItems.length})');
  });

  it('renders cancelled tasks in a separate collapsed section', () => {
    expect(source).toContain('Cancelled ({cancelledItems.length})');
    expect(source).toContain('aria-expanded={showCancelled}');
    expect(source).toContain('aria-controls="my-day-cancelled-tasks"');
    expect(source).toContain('partitionMyDayItems(filteredItems)');
    expect(mobileSource).toContain('Cancelled ({cancelledItems.length})');
    expect(mobileSource).toContain('aria-controls="mobile-my-day-cancelled-tasks"');
    expect(mobileSource).toContain('totalActive === 0 ? (');
  });

  it('excludes inactive tasks from mobile, timeline, and scheduled-time surfaces', () => {
    expect(timelineSource).toContain('!isInactiveTaskStatus(i.status)');
    expect(timelineSource).toContain("s.status !== 'cancelled'");
    expect(source).toContain(".filter((task) => task.status !== 'cancelled')");
    expect(pageSource).toContain(".filter((task) => task.status !== 'cancelled')");
  });

  it('constrains the desktop suggestions panel so expanded groups remain scrollable', () => {
    expect(pageSource).toContain('className="hidden h-full min-h-0 sm:block"');
    expect(sidebarSource).toContain('flex h-full min-h-0 w-80');
    expect(sidebarSource).toContain('min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain');
  });
});
