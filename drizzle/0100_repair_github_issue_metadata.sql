UPDATE tasks
SET metadata = json_set(
  CASE
    WHEN json_valid(metadata) AND json_type(metadata) = 'object' THEN metadata
    WHEN json_valid(metadata)
      AND json_type(metadata) = 'text'
      AND json_valid(json_extract(metadata, '$'))
      AND json_type(json_extract(metadata, '$')) = 'object'
      THEN json_extract(metadata, '$')
    ELSE '{}'
  END,
  '$.issueNumber',
  CAST(substr(source_id, instr(source_id, ':') + 1) AS INTEGER)
)
WHERE connector_type = 'github-issues'
  AND source_id GLOB '*:[0-9]*'
  AND substr(source_id, instr(source_id, ':') + 1) NOT GLOB '*[^0-9]*'
  AND CAST(substr(source_id, instr(source_id, ':') + 1) AS INTEGER) > 0;--> statement-breakpoint
