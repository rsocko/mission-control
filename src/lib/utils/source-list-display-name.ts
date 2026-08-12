/**
 * Resolve the display name for a source list.
 * 
 * `userDisplayName` is set only by user rename actions and is never
 * touched by sync.  When present it takes priority over the synced
 * remote `name`.
 */
export function resolveSourceListDisplayName(
  sourceList: { name: string; userDisplayName?: string | null },
): string {
  return sourceList.userDisplayName || sourceList.name;
}
