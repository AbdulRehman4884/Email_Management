CREATE TABLE IF NOT EXISTS "email_replies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_replies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"campaign_id" integer NOT NULL,
	"recipient_id" integer NOT NULL,
	"from_email" varchar(255) NOT NULL,
	"subject" varchar(500) NOT NULL,
	"body_text" varchar(10000),
	"body_html" varchar(20000),
	"received_at" timestamp DEFAULT now() NOT NULL,
	"message_id" varchar(500),
	"in_reply_to" varchar(500)
);
--> statement-breakpoint
ALTER TABLE "email_replies" ADD CONSTRAINT "email_replies_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_replies" ADD CONSTRAINT "email_replies_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE no action ON UPDATE no action;
