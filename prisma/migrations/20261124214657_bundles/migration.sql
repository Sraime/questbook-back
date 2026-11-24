-- AlterTable
ALTER TABLE "scenario_npcs" ADD COLUMN     "token" TEXT;

-- AlterTable
ALTER TABLE "session_npc_tokens" ALTER COLUMN "token" DROP NOT NULL;

-- AlterTable
ALTER TABLE "shop_items" ADD COLUMN     "image" BYTEA,
ADD COLUMN     "image_hash" TEXT,
ADD COLUMN     "image_type" TEXT;

-- CreateTable
CREATE TABLE "shop_bundle_entries" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "asset_item_id" TEXT,
    "scenario_id" TEXT,

    CONSTRAINT "shop_bundle_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shop_bundle_entries_bundle_id_sort_order_idx" ON "shop_bundle_entries"("bundle_id", "sort_order");

-- AddForeignKey
ALTER TABLE "shop_bundle_entries" ADD CONSTRAINT "shop_bundle_entries_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "shop_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_bundle_entries" ADD CONSTRAINT "shop_bundle_entries_asset_item_id_fkey" FOREIGN KEY ("asset_item_id") REFERENCES "shop_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_bundle_entries" ADD CONSTRAINT "shop_bundle_entries_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one of the two: an entry hands over an asset or a scenario.
ALTER TABLE "shop_bundle_entries" ADD CONSTRAINT "shop_bundle_entries_one_target"
  CHECK (("asset_item_id" IS NULL) <> ("scenario_id" IS NULL));

-- The same thing twice in one bundle would list it twice.
CREATE UNIQUE INDEX "shop_bundle_entries_bundle_asset_key" ON "shop_bundle_entries"("bundle_id", "asset_item_id");
CREATE UNIQUE INDEX "shop_bundle_entries_bundle_scenario_key" ON "shop_bundle_entries"("bundle_id", "scenario_id");

-- pack was never sold: the type is renamed before anything uses it.
UPDATE "shop_items" SET "type" = 'bundle' WHERE "type" = 'pack';