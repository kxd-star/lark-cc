CREATE TABLE `feishu_parent_replies` (
	`parent_id` text PRIMARY KEY NOT NULL,
	`bot_reply_id` text NOT NULL,
	`created_at` integer NOT NULL
);
