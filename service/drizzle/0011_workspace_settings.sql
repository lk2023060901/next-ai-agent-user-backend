CREATE TABLE IF NOT EXISTS `workspace_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`default_model` text DEFAULT '',
	`default_temperature` real DEFAULT 0.7,
	`max_tokens_per_request` integer DEFAULT 8192,
	`assistant_model_ids` text DEFAULT '[]',
	`fallback_model_ids` text DEFAULT '[]',
	`code_model_ids` text DEFAULT '[]',
	`agent_model_ids` text DEFAULT '[]',
	`sub_agent_model_ids` text DEFAULT '[]',
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
