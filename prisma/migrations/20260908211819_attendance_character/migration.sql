-- AlterTable
ALTER TABLE "session_attendances" ADD COLUMN     "character_id" TEXT;

-- CreateIndex
CREATE INDEX "session_attendances_character_id_idx" ON "session_attendances"("character_id");

-- AddForeignKey
ALTER TABLE "session_attendances" ADD CONSTRAINT "session_attendances_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
