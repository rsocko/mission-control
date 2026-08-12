import type { ProjectHealth } from '@/types';

export interface PortfolioVisualProject {
  id: string;
  name: string;
  color: string;
  status: string;
  targetDate: string | null;
  progress: {
    totalTasks: number;
    completedTasks: number;
    percentComplete: number;
    health: ProjectHealth;
  };
}

export interface PortfolioVisualCategory {
  category: string;
  projects: PortfolioVisualProject[];
}

export interface CategoryPortfolioRow {
  category: string;
  projectCount: number;
  totalTasks: number;
  percentComplete: number;
  health: Record<ProjectHealth, number>;
}

export interface DeadlineRunwayItem extends PortfolioVisualProject {
  daysRemaining: number;
}

export function buildCategoryPortfolioRows(
  categories: PortfolioVisualCategory[],
  uncategorized: PortfolioVisualProject[],
): CategoryPortfolioRow[] {
  const groups = uncategorized.length > 0
    ? [...categories, { category: 'Uncategorized', projects: uncategorized }]
    : categories;

  return groups
    .filter(group => group.projects.length > 0)
    .map((group) => {
      const totalTasks = group.projects.reduce((sum, project) => sum + project.progress.totalTasks, 0);
      const completedTasks = group.projects.reduce((sum, project) => sum + project.progress.completedTasks, 0);

      return {
        category: group.category,
        projectCount: group.projects.length,
        totalTasks,
        percentComplete: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
        health: {
          on_track: group.projects.filter(project => project.progress.health === 'on_track').length,
          at_risk: group.projects.filter(project => project.progress.health === 'at_risk').length,
          behind: group.projects.filter(project => project.progress.health === 'behind').length,
        },
      };
    })
    .sort((a, b) => b.projectCount - a.projectCount || a.category.localeCompare(b.category));
}

function parseTargetDate(value: string): Date | null {
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      parsed.getFullYear() !== Number(year)
      || parsed.getMonth() !== Number(month) - 1
      || parsed.getDate() !== Number(day)
    ) {
      return null;
    }
    return parsed;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function calendarDayValue(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function buildDeadlineRunway(
  categories: PortfolioVisualCategory[],
  uncategorized: PortfolioVisualProject[],
  now = new Date(),
  limit = 5,
): DeadlineRunwayItem[] {
  return [...categories.flatMap(group => group.projects), ...uncategorized]
    .filter(project => project.status !== 'completed' && project.status !== 'cancelled' && project.targetDate)
    .map((project) => {
      const target = parseTargetDate(project.targetDate!);
      if (!target) return null;

      return {
        ...project,
        daysRemaining: Math.round((calendarDayValue(target) - calendarDayValue(now)) / 86_400_000),
      };
    })
    .filter((project): project is DeadlineRunwayItem => project !== null)
    .sort((a, b) => a.daysRemaining - b.daysRemaining || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}
