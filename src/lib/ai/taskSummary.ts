export function countCriticalAndHighTasks(tasks: Array<{ priority: string | null }>) {
  return tasks.filter(task => task.priority === 'critical' || task.priority === 'high').length;
}
