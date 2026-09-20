-- CreateTable
CREATE TABLE "session_npcs" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_npcs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_npcs_session_id_created_at_idx" ON "session_npcs"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "session_npcs" ADD CONSTRAINT "session_npcs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
