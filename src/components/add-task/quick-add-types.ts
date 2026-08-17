export interface QuickAddDestination {
  id: string;
  label: string;
  shortLabel?: string;
  connectorType: string;
  account: 'personal' | 'work' | null;
  color: string;
  listId?: string;
  listName?: string;
  listSelectionMode?: 'required' | 'optional' | 'not-applicable';
  groupName?: string;
  groupSortOrder?: number;
}

export interface QuickAddPendingTask {
  id: string;
  text: string;
  parentIndex: number | null;
  /** Existing parent ID used when retrying a subtask after its parent was created. */
  parentTaskId?: string;
  isComplete: boolean;
}
