-- CreateTable
CREATE TABLE "session_clues" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'markdown',
    "content_markdown" TEXT NOT NULL DEFAULT '',
    "asset_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_clues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_clue_access" (
    "id" TEXT NOT NULL,
    "clue_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_clue_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_clues_session_id_created_at_idx" ON "session_clues"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "session_clue_access_user_id_idx" ON "session_clue_access"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_clue_access_clue_id_user_id_key" ON "session_clue_access"("clue_id", "user_id");

-- AddForeignKey
ALTER TABLE "session_clues" ADD CONSTRAINT "session_clues_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_clue_access" ADD CONSTRAINT "session_clue_access_clue_id_fkey" FOREIGN KEY ("clue_id") REFERENCES "session_clues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_clue_access" ADD CONSTRAINT "session_clue_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
