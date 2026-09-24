ALTER TABLE `llm_calls` ADD `attempt` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `kind` text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `tier` text;