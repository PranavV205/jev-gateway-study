CREATE TABLE `screen_results` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`target` text NOT NULL,
	`classifier` text NOT NULL,
	`model` text,
	`p_injection` real,
	`p_exfil` real,
	`action` text NOT NULL,
	`reason` text,
	`input_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`latency_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`raw_json` text,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `requests` ADD `flagged` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `requests` ADD `classifier` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `requests` ADD `screen_cost_usd` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `requests` ADD `screen_latency_ms` integer DEFAULT 0 NOT NULL;