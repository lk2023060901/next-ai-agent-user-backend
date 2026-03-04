ALTER TABLE `knowledge_bases` DROP COLUMN `description`;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `requested_document_chunks` integer NOT NULL DEFAULT 5;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `document_processing` text;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `reranker_model` text;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `matching_threshold` real;
