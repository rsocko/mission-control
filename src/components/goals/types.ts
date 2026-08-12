import { Brain, Lightbulb, Target, type LucideIcon } from 'lucide-react';

export type GoalType = 'goal' | 'idea' | 'brainstorm';
export type FilterType = 'all' | GoalType;

export interface GoalTag {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  type: string;
}

export interface LinkedProject {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  totalTasks?: number;
  doneTasks?: number;
  progress?: number;
  milestones?: Array<{
    id: string;
    name: string;
    targetDate: string | null;
    completed: boolean;
  }>;
}

export interface GoalItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  goalType: GoalType;
  tags: GoalTag[];
  linkedProjects: LinkedProject[];
  progress?: number;
  totalTasks?: number;
  doneTasks?: number;
  dueDate?: string | null;
  createdAt: string;
  updatedAt: string;
  connectorType: string;
}

export interface DevelopProposal {
  summary: string;
  suggestedTasks: Array<{
    title: string;
    description: string;
    effort: string;
    category: string;
  }>;
  suggestedProject: {
    name: string;
    description: string;
    category: string;
    phases: Array<{
      name: string;
      description: string;
      taskIndices: number[];
    }>;
    estimatedEffortDays: number;
  } | null;
}

export const GOAL_TYPE_CONFIG: Record<
  GoalType,
  {
    icon: LucideIcon;
    label: string;
    sublabel: string;
    color: string;
    bgColor: string;
    badgeColor: string;
  }
> = {
  goal: {
    icon: Target,
    label: 'Goals',
    sublabel: 'Long-term outcomes & aspirations',
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
    badgeColor: 'bg-blue-500/20 text-blue-300',
  },
  idea: {
    icon: Lightbulb,
    label: 'Ideas',
    sublabel: 'Raw concepts & possibilities',
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    badgeColor: 'bg-amber-500/20 text-amber-300',
  },
  brainstorm: {
    icon: Brain,
    label: 'Brainstorms',
    sublabel: 'Open questions & explorations',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
    badgeColor: 'bg-purple-500/20 text-purple-300',
  },
};

export function getRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1d ago';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}
