ALTER TABLE `agent_runs` ADD `coordinator_input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `coordinator_output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `coordinator_total_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `sub_agent_input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `sub_agent_output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `sub_agent_total_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `total_input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `total_output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `total_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `task_success_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `task_failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD `input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD `output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD `total_tokens` integer DEFAULT 0 NOT NULL;