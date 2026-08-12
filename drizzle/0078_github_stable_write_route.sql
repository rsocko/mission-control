ALTER TABLE `task_source_write_leases`
ADD `identity_route` text NOT NULL DEFAULT 'legacy'
CHECK (`identity_route` IN ('legacy', 'stable'));