import { sql, type SQL } from 'drizzle-orm';
import { taskAttachments } from '@/db/schema';

type TaskAttachmentSnapshot = Pick<
  typeof taskAttachments.$inferSelect,
  'id' | 'size' | 'sourceAttachmentId'
>;

export function taskAttachmentSnapshotPredicates(
  taskId: string,
  attachments: TaskAttachmentSnapshot[],
): SQL[] {
  return [
    sql`(
      SELECT COUNT(*)
      FROM task_attachments
      WHERE task_id = ${taskId}
    ) = ${attachments.length}`,
    ...attachments.map((attachment) => sql`EXISTS (
      SELECT 1
      FROM task_attachments
      WHERE task_id = ${taskId}
        AND id = ${attachment.id}
        AND size = ${attachment.size}
        AND source_attachment_id IS ${attachment.sourceAttachmentId}
    )`),
  ];
}
