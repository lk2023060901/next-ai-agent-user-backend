CREATE TABLE `plugin_install_records` (
	`id` text PRIMARY KEY NOT NULL,
	`installed_plugin_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_spec` text NOT NULL,
	`resolved_spec` text,
	`resolved_version` text,
	`expected_integrity` text,
	`resolved_integrity` text,
	`shasum` text,
	`artifact_sha256` text NOT NULL,
	`artifact_sha512` text NOT NULL,
	`install_path` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`installed_plugin_id`) REFERENCES `installed_plugins`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_install_records_installed_plugin_id_uniq` ON `plugin_install_records` (`installed_plugin_id`);
--> statement-breakpoint
CREATE INDEX `plugin_install_records_workspace_plugin_idx` ON `plugin_install_records` (`workspace_id`,`plugin_id`);
--> statement-breakpoint
CREATE TABLE `plugin_install_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`installed_plugin_id` text,
	`actor_user_id` text,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`source_type` text,
	`source_spec` text,
	`expected_integrity` text,
	`resolved_integrity` text,
	`artifact_sha256` text,
	`artifact_sha512` text,
	`message` text,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plugin_install_audits_workspace_created_idx` ON `plugin_install_audits` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `plugin_install_audits_plugin_created_idx` ON `plugin_install_audits` (`plugin_id`,`created_at`);
