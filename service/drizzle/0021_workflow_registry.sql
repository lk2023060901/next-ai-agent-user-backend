CREATE TABLE `workflows` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `status` text NOT NULL DEFAULT 'draft',
  `spec_version` text NOT NULL DEFAULT 'wf.v1',
  `revision` integer NOT NULL DEFAULT 1,
  `data_json` text NOT NULL DEFAULT '{}',
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE INDEX `workflows_workspace_id_idx` ON `workflows` (`workspace_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_workspace_name_uq` ON `workflows` (`workspace_id`, `name`);
--> statement-breakpoint

INSERT INTO `workflows` (
  `id`,
  `workspace_id`,
  `name`,
  `description`,
  `status`,
  `spec_version`,
  `revision`,
  `data_json`,
  `created_at`,
  `updated_at`
)
SELECT
  'wf-' || b.workspace_id,
  b.workspace_id,
  'Default Workflow',
  NULL,
  'draft',
  'wf.v1',
  1,
  b.data_json,
  datetime('now'),
  b.updated_at
FROM `blueprints` b
WHERE NOT EXISTS (
  SELECT 1 FROM `workflows` w WHERE w.workspace_id = b.workspace_id
);
