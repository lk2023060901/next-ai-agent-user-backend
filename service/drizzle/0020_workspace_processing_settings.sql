ALTER TABLE `workspace_settings` ADD COLUMN `ocr_provider` text DEFAULT 'system_ocr';
--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD COLUMN `ocr_config_json` text DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD COLUMN `document_processing_provider` text DEFAULT '';
--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD COLUMN `document_processing_config_json` text DEFAULT '{}';
