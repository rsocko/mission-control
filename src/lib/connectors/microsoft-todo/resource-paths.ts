export function graphTodoListPath(listId: string): string {
  return `/me/todo/lists/${encodeURIComponent(listId)}`;
}

export function graphTodoTasksPath(listId: string): string {
  return `${graphTodoListPath(listId)}/tasks`;
}

export function graphTodoTaskPath(listId: string, taskId: string): string {
  return `${graphTodoTasksPath(listId)}/${encodeURIComponent(taskId)}`;
}

export function graphTodoChecklistItemPath(
  listId: string,
  taskId: string,
  checklistItemId: string,
): string {
  return `${graphTodoTaskPath(listId, taskId)}/checklistItems/${encodeURIComponent(checklistItemId)}`;
}
