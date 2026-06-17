CREATE TABLE `feishu_message_text_cache` (
	`message_id` text PRIMARY KEY NOT NULL,
	`text_content` text NOT NULL,
	`created_at` integer NOT NULL
);
