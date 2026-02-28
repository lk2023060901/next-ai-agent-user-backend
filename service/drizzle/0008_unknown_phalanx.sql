CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`org_id` text NOT NULL,
	`session_id` text,
	`run_id` text,
	`task_id` text,
	`record_type` text NOT NULL,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	`agent_id` text,
	`agent_name` text DEFAULT '' NOT NULL,
	`agent_role` text DEFAULT '' NOT NULL,
	`provider_id` text,
	`provider_name` text DEFAULT '' NOT NULL,
	`model_id` text,
	`model_name` text DEFAULT '' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`ended_at` text,
	`recorded_at` text DEFAULT (datetime('now')) NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `usage_records_ws_recorded_at_idx` ON `usage_records` (`workspace_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `usage_records_org_recorded_at_idx` ON `usage_records` (`org_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `usage_records_run_id_idx` ON `usage_records` (`run_id`);--> statement-breakpoint
CREATE INDEX `usage_records_task_id_idx` ON `usage_records` (`task_id`);--> statement-breakpoint
CREATE INDEX `usage_records_agent_id_idx` ON `usage_records` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_records_run_scope_uniq` ON `usage_records` (`run_id`,`record_type`,`scope`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_records_task_uniq` ON `usage_records` (`task_id`,`record_type`);