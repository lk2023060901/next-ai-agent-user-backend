ALTER TABLE `chat_sessions` ADD `is_pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `pinned_at` text;