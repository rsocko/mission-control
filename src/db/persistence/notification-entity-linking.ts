export interface NotificationEntityLinkingRepository {
  findTaskBySourceReference(input: {
    connectorInstanceId: string;
    repository: string;
    number: number;
  }): Promise<{ id: string } | null>;
  findProjectByRepository(repository: string): Promise<string | null>;
}
