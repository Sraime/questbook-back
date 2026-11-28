-- Le lien public qui projette le plateau d'une seance.
ALTER TABLE "game_sessions" ADD COLUMN "projection_token_hash" TEXT;
CREATE UNIQUE INDEX "game_sessions_projection_token_hash_key" ON "game_sessions"("projection_token_hash");
