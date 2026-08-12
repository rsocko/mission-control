export interface TagInsightTask {
  id: string;
  title: string;
  status: string;
}

export interface TagInsightTag {
  id: string;
  name: string;
  color: string | null;
  taskCount: number;
  taskIds: string[];
}

export interface TagInsightPair {
  key: string;
  sourceTagId: string;
  targetTagId: string;
  count: number;
  taskIds: string[];
}

export interface TagInsights {
  tags: TagInsightTag[];
  pairs: TagInsightPair[];
  tasks: Record<string, TagInsightTask>;
  meta: {
    topN: number;
    minCooccurrence: number;
    taskLimit: number;
    processedTaskCount: number;
    truncated: boolean;
  };
}

export interface TagInsightRecord {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  tagId: string;
  tagName: string;
  tagColor: string | null;
}
