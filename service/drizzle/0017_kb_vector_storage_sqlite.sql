ALTER TABLE `kb_documents` ADD COLUMN `chunk_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `kb_documents` ADD COLUMN `processed_at` text;
--> statement-breakpoint
ALTER TABLE `kb_documents` ADD COLUMN `error_message` text;
--> statement-breakpoint
CREATE TABLE `kb_document_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`knowledge_base_id` text NOT NULL,
	`document_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`content` text NOT NULL,
	`embedding_json` text NOT NULL,
	`embedding_dim` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `kb_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `kb_document_chunks_kb_idx` ON `kb_document_chunks` (`knowledge_base_id`);
--> statement-breakpoint
CREATE INDEX `kb_document_chunks_doc_idx` ON `kb_document_chunks` (`document_id`);
--> statement-breakpoint
CREATE INDEX `kb_document_chunks_kb_doc_chunk_idx` ON `kb_document_chunks` (`knowledge_base_id`,`document_id`,`chunk_index`);
