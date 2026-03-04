CREATE TABLE IF NOT EXISTS `plugin_favorites` (
  `id` text PRIMARY KEY NOT NULL,
  `plugin_id` text NOT NULL REFERENCES `plugins`(`id`) ON DELETE cascade ON UPDATE no action,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `plugin_favorites_plugin_user_uniq` ON `plugin_favorites` (`plugin_id`,`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plugin_favorites_plugin_idx` ON `plugin_favorites` (`plugin_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plugin_favorites_user_idx` ON `plugin_favorites` (`user_id`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `plugin_reviews` (
  `id` text PRIMARY KEY NOT NULL,
  `plugin_id` text NOT NULL REFERENCES `plugins`(`id`) ON DELETE cascade ON UPDATE no action,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
  `rating` real NOT NULL,
  `content` text NOT NULL DEFAULT '',
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `plugin_reviews_plugin_user_uniq` ON `plugin_reviews` (`plugin_id`,`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plugin_reviews_plugin_idx` ON `plugin_reviews` (`plugin_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plugin_reviews_user_idx` ON `plugin_reviews` (`user_id`);
