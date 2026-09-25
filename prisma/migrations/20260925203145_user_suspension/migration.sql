-- AlterTable
ALTER TABLE "users" ADD COLUMN     "suspended_at" TIMESTAMP(3),
ADD COLUMN     "suspended_until" TIMESTAMP(3),
ADD COLUMN     "suspension_reason" TEXT;
