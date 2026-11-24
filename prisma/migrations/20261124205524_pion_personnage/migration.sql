-- AlterTable
ALTER TABLE "characters" ADD COLUMN     "token" TEXT;

-- CreateTable
CREATE TABLE "session_npc_tokens" (
    "session_id" TEXT NOT NULL,
    "npc_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,

    CONSTRAINT "session_npc_tokens_pkey" PRIMARY KEY ("session_id","npc_id")
);

-- AddForeignKey
ALTER TABLE "session_npc_tokens" ADD CONSTRAINT "session_npc_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
