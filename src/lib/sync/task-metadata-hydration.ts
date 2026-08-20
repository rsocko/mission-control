export function needsMicrosoftTodoLinkedResourceHydration(
  connectorType: string,
  existingMetadata: Record<string, unknown>,
  remoteMetadata: Record<string, unknown> | undefined,
): boolean {
  return connectorType === 'microsoft-todo'
    && !Object.hasOwn(existingMetadata, 'linkedResources')
    && Object.hasOwn(remoteMetadata ?? {}, 'linkedResources');
}
