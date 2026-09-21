-- Le plateau d'une session, tel que le MJ l'a pousse la derniere fois.
--
-- Une seule ligne par session, et non par session et par compte comme sur
-- l'appareil : c'est le plateau de la table, pas celui d'une tablette.

-- CreateTable
CREATE TABLE "session_boards" (
    "session_id" TEXT NOT NULL,
    "tokens" TEXT NOT NULL DEFAULT '[]',
    "map_id" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_boards_pkey" PRIMARY KEY ("session_id")
);

-- AddForeignKey
ALTER TABLE "session_boards" ADD CONSTRAINT "session_boards_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
