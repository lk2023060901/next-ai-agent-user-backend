ALTER TABLE `scheduled_tasks` ADD `schedule_type` text DEFAULT 'cron' NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `run_at` text;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `max_runs` integer;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `run_count` integer DEFAULT 0 NOT NULL;