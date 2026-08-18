export function mergePendingSourceListRenames<T extends { id: string; name: string }>(
  sourceLists: T[],
  pendingRenames: ReadonlyMap<string, string>,
): T[] {
  if (pendingRenames.size === 0) return sourceLists;

  return sourceLists.map((sourceList) => {
    const pendingName = pendingRenames.get(sourceList.id);
    return pendingName === undefined
      ? sourceList
      : { ...sourceList, name: pendingName };
  });
}

export function resolveSourceListRefresh<T extends { id: string; name: string }>(
  sourceLists: T[],
  pendingRenames: ReadonlyMap<string, string>,
  startedVersion: number,
  currentVersion: number,
): T[] | null {
  if (startedVersion !== currentVersion) return null;
  return mergePendingSourceListRenames(sourceLists, pendingRenames);
}

export async function runSourceListRenameRequest(
  request: () => Promise<Response>,
  onSettled: (response: Response | undefined) => Promise<void>,
): Promise<Response> {
  let response: Response | undefined;
  try {
    response = await request();
    return response;
  } finally {
    await onSettled(response);
  }
}

export async function settleSourceListRename(
  response: Response | undefined,
  clearPending: () => void | Promise<void>,
  refresh: () => Promise<void>,
): Promise<void> {
  if (!response?.ok) await clearPending();
  try {
    await refresh();
  } finally {
    if (response?.ok) await clearPending();
  }
}
