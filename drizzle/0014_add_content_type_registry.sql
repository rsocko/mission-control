-- Add content type registry table for user-defined content types with detection hints
CREATE TABLE IF NOT EXISTS `triage_content_types` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `icon` text,
  `color` text NOT NULL DEFAULT '#6b7280',
  `builtin` integer NOT NULL DEFAULT 0,
  `suppressed` integer NOT NULL DEFAULT 0,
  `priority` integer NOT NULL DEFAULT 50,
  `url_patterns` text NOT NULL DEFAULT '[]',
  `keyword_hints` text NOT NULL DEFAULT '[]',
  `description` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
