export const TASK_MOVE_BUDGETS = {
  maxSubtasks: 100,
  maxAttachments: 50,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxTotalAttachmentBytes: 25 * 1024 * 1024,
} as const;

export class TaskMoveBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskMoveBudgetError';
  }
}

export function assertTaskMoveAttachmentBudget(
  attachments: Array<{ name: string; size: number }>,
): void {
  if (attachments.length > TASK_MOVE_BUDGETS.maxAttachments) {
    throw new TaskMoveBudgetError(
      `Task moves support at most ${TASK_MOVE_BUDGETS.maxAttachments} attachments; reduce the task size and retry.`,
    );
  }

  let totalBytes = 0;
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw new TaskMoveBudgetError(`Attachment "${attachment.name}" has an invalid size.`);
    }
    if (attachment.size > TASK_MOVE_BUDGETS.maxAttachmentBytes) {
      throw new TaskMoveBudgetError(
        `Attachment "${attachment.name}" exceeds the ${TASK_MOVE_BUDGETS.maxAttachmentBytes}-byte limit.`,
      );
    }
    totalBytes += attachment.size;
  }
  if (totalBytes > TASK_MOVE_BUDGETS.maxTotalAttachmentBytes) {
    throw new TaskMoveBudgetError(
      `Attachments exceed the ${TASK_MOVE_BUDGETS.maxTotalAttachmentBytes}-byte task move limit.`,
    );
  }
}

export function assertMaterializedTaskMoveAttachmentBudget(
  attachments: Array<{ name: string; contentBase64: string }>,
): void {
  let totalBytes = 0;
  for (const attachment of attachments) {
    const materializedBytes = Buffer.from(attachment.contentBase64, 'base64').byteLength;
    if (materializedBytes > TASK_MOVE_BUDGETS.maxAttachmentBytes) {
      throw new TaskMoveBudgetError(
        `Attachment "${attachment.name}" exceeds the attachment byte limit.`,
      );
    }
    totalBytes += materializedBytes;
  }
  if (totalBytes > TASK_MOVE_BUDGETS.maxTotalAttachmentBytes) {
    throw new TaskMoveBudgetError(
      `Attachments exceed the ${TASK_MOVE_BUDGETS.maxTotalAttachmentBytes}-byte task move limit.`,
    );
  }
}
