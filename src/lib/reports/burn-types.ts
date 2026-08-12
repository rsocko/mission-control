export type BurnReportMode = 'count' | 'effort';
export type BurnReportScope = 'project' | 'phase';

export interface BurnReportPoint {
  date: string;
  total: number | null;
  completed: number | null;
  remaining: number | null;
  todo: number | null;
  inProgress: number | null;
  cancelled: number | null;
  idealCompleted: number | null;
  idealRemaining: number | null;
  effortCoverage: number | null;
  estimateIncomplete: boolean;
  partial: boolean;
  completedTaskIds: string[];
  remainingTaskIds: string[];
  statusTaskIds: {
    todo: string[];
    inProgress: string[];
    done: string[];
    cancelled: string[];
  };
}

export interface BurnReportTask {
  id: string;
  title: string;
  createdAt?: string;
  completedAt?: string | null;
}

export interface BurnReport {
  projectId: string;
  scope: BurnReportScope;
  scopeId: string;
  scopeName: string;
  mode: BurnReportMode;
  unitLabel: 'tasks' | 'effort points';
  range: {
    start: string;
    end: string;
  };
  points: BurnReportPoint[];
  tasks: BurnReportTask[];
  partialHistory: boolean;
  historicalBoundaryAt: string | null;
  completeFromDate: string | null;
  effort: {
    available: boolean;
    coverage: number;
    estimatedTasks: number;
    totalTasks: number;
    threshold: number;
    message: string | null;
  };
  ideal: {
    available: boolean;
    start: string | null;
    end: string | null;
    message: string | null;
  };
}
