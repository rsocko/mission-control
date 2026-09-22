export function needsMicrosoftTodoLinkedResourceHydration(
  connectorType: string,
  existingMetadata: Record<string, unknown>,
  remoteMetadata: Record<string, unknown> | undefined,
): boolean {
  if (
    connectorType !== 'microsoft-todo'
    || !Object.hasOwn(remoteMetadata ?? {}, 'linkedResources')
  ) {
    return false;
  }
  return JSON.stringify(existingMetadata.linkedResources)
    !== JSON.stringify(remoteMetadata?.linkedResources);
}
