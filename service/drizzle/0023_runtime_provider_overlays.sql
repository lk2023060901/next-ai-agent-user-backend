CREATE TABLE `provider_overrides` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `name` text,
  `type` text,
  `base_url` text,
  `api_key_encrypted` text,
  `status` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_overrides_ws_provider_uq` ON `provider_overrides` (`workspace_id`, `provider_id`);
--> statement-breakpoint
CREATE INDEX `provider_overrides_workspace_idx` ON `provider_overrides` (`workspace_id`);
--> statement-breakpoint

CREATE TABLE `custom_providers` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `type` text NOT NULL,
  `base_url` text,
  `api_key_encrypted` text,
  `status` text NOT NULL DEFAULT 'active',
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `custom_providers_workspace_idx` ON `custom_providers` (`workspace_id`);
--> statement-breakpoint

CREATE TABLE `model_overrides` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `model_name` text NOT NULL,
  `display_name` text,
  `context_window` integer,
  `max_output` integer,
  `input_price` real,
  `output_price` real,
  `capabilities_json` text,
  `enabled` integer,
  `series_name` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_overrides_ws_provider_model_uq` ON `model_overrides` (`workspace_id`, `provider_id`, `model_name`);
--> statement-breakpoint
CREATE INDEX `model_overrides_workspace_provider_idx` ON `model_overrides` (`workspace_id`, `provider_id`);
--> statement-breakpoint

CREATE TABLE `custom_models` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `name` text NOT NULL,
  `display_name` text NOT NULL,
  `context_window` integer NOT NULL DEFAULT 8192,
  `max_output` integer NOT NULL DEFAULT 4096,
  `input_price` real NOT NULL DEFAULT 0,
  `output_price` real NOT NULL DEFAULT 0,
  `capabilities_json` text NOT NULL DEFAULT '[]',
  `enabled` integer NOT NULL DEFAULT true,
  `series_name` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_models_ws_provider_model_uq` ON `custom_models` (`workspace_id`, `provider_id`, `name`);
--> statement-breakpoint
CREATE INDEX `custom_models_workspace_provider_idx` ON `custom_models` (`workspace_id`, `provider_id`);
