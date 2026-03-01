ALTER TABLE `messages` ADD COLUMN `run_id` text REFERENCES `agent_runs`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_run_id_idx` ON `messages` (`run_id`);
