import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const allTasksRoute = readFileSync(
  resolve(process.cwd(), 'src/app/all-tasks/page.tsx'),
  'utf8',
);
const dashboardPage = readFileSync(
  resolve(process.cwd(), 'src/app/page.tsx'),
  'utf8',
);

describe('All Tasks route layout', () => {
  it('reuses the dashboard task workspace without redirecting desktop users', () => {
    expect(allTasksRoute.trim()).toBe("export { default } from '../page';");
    expect(allTasksRoute).not.toContain("router.replace('/')");
  });

  it('keeps dashboard widgets off All Tasks while retaining the mobile task view', () => {
    expect(dashboardPage).toContain("return pathname === '/all-tasks' ? <AllTasksPageInner />");
    expect(dashboardPage).toContain('{!isAllTasksPage && (');
    expect(dashboardPage).toContain('if (isPhone) return <MobileAllTasksList />;');
    expect(dashboardPage).toContain('return <DashboardWorkspace isAllTasksPage />;');
  });
});
