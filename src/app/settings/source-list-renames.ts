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
  onSettled: () => Promise<void>,
): Promise<Response> {
  try {
    return await request();
  } finally {
    await onSettled();
  }
}
