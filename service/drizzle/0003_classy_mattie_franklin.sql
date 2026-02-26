CREATE TABLE `channel_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`agent_id` text,
	`last_active_at` text DEFAULT (datetime('now')) NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
