import { getAIWorkflowPersistence } from '../workflow-persistence';

export async function listNotificationsForClassification() {
  return (await getAIWorkflowPersistence()).notifications.listForClassification(
    new Date().toISOString(),
    20,
  );
}
