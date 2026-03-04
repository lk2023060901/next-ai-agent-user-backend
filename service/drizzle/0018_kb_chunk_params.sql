ALTER TABLE `knowledge_bases` ADD COLUMN `chunk_size` integer NOT NULL DEFAULT 1200;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `chunk_overlap` integer NOT NULL DEFAULT 200;
