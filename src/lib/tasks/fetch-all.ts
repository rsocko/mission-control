const TASK_PAGE_SIZE = 200;

interface TaskPage<T> {
  tasks?: T[];
  hasMore?: boolean;
}

export async function fetchAllTasks<T>(path: string, init?: RequestInit): Promise<T[]> {
  const url = new URL(path, window.location.origin);
  const tasks: T[] = [];
  let offset = 0;

  while (true) {
    url.searchParams.set('limit', String(TASK_PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    const response = await fetch(`${url.pathname}${url.search}`, init);
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error || 'Failed to load tasks');
    }
    const page = (await response.json()) as TaskPage<T>;
    const pageTasks = page.tasks ?? [];
    tasks.push(...pageTasks);
    offset += pageTasks.length;
    if (!page.hasMore || pageTasks.length === 0) break;
    if (offset > 100_000) {
      throw new Error('Task result exceeds the supported pagination window');
    }
  }

  return tasks;
}
