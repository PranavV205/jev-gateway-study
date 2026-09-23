CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`latency_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`app_id` text NOT NULL,
	`user_message_hash` text NOT NULL,
	`chunk_count` integer NOT NULL,
	`action` text NOT NULL,
	`tier` text,
	`provider` text,
	`model` text,
	`cost_usd` real NOT NULL,
	`baseline_cost_usd` real NOT NULL,
	`latency_ms` integer NOT NULL,
	`config_version` text NOT NULL,
	`error` text
);
