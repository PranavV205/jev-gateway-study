CREATE TABLE `route_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`router` text NOT NULL,
	`model` text,
	`task_type` text,
	`task_probs_json` text,
	`confidence` real,
	`p_needs_strong` real,
	`tier` text NOT NULL,
	`reason` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`latency_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `requests` ADD `router` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `requests` ADD `route_reason` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `route_cost_usd` real DEFAULT 0 NOT NULL;