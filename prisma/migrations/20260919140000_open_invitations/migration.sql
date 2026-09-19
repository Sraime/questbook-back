-- Allow inviting an address that has no Questbook account yet. The unique
-- key becomes the mailbox itself so two pending rows cannot target the same
-- person at one table, whether or not they have signed in.

ALTER TABLE "table_invitations" ALTER COLUMN "invited_user_id" DROP NOT NULL;

DROP INDEX "table_invitations_table_id_invited_user_id_key";

CREATE UNIQUE INDEX "table_invitations_table_id_email_key" ON "table_invitations"("table_id", "email");
