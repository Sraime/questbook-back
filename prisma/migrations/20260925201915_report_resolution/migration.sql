-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "resolution_note" TEXT,
ADD COLUMN     "resolved_at" TIMESTAMP(3),
ADD COLUMN     "resolved_by_id" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'open';

-- CreateIndex
CREATE INDEX "reports_status_created_at_idx" ON "reports"("status", "created_at");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
