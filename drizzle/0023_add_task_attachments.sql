CREATE TABLE `task_attachments` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `name` text NOT NULL,
  `content_type` text NOT NULL,
  `size` integer NOT NULL,
  `content_base64` text,
  `source_attachment_id` text,
  `created_at` text NOT NULL
);

CREATE INDEX `idx_task_attachments_task_id` ON `task_attachments`(`task_id`);
