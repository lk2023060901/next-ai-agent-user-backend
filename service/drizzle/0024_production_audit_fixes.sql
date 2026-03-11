CREATE UNIQUE INDEX IF NOT EXISTS `workspaces_org_slug_uq` ON `workspaces` (`org_id`, `slug`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_kb_uq` ON `agent_knowledge_bases` (`agent_id`, `knowledge_base_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `kb_workspace_id_idx` ON `knowledge_bases` (`workspace_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_providers_workspace_id_idx` ON `ai_providers` (`workspace_id`);
