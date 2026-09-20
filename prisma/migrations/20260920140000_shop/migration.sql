-- CreateTable
CREATE TABLE "shop_items" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "image_key" TEXT NOT NULL,
    "asset_key" TEXT,
    "scenario_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_item_ownerships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'purchase',
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_item_ownerships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shop_items_sort_order_idx" ON "shop_items"("sort_order");

-- CreateIndex
CREATE INDEX "shop_item_ownerships_user_id_idx" ON "shop_item_ownerships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_item_ownerships_user_id_item_id_key" ON "shop_item_ownerships"("user_id", "item_id");

-- AddForeignKey
ALTER TABLE "shop_items" ADD CONSTRAINT "shop_items_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_item_ownerships" ADD CONSTRAINT "shop_item_ownerships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_item_ownerships" ADD CONSTRAINT "shop_item_ownerships_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "shop_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The whole catalogue for now: one free character token, bearing the emblem
-- the app already wears in its top bar. `image_key` and `asset_key` name
-- things the client draws; nothing here hosts files.
INSERT INTO "shop_items" (
  "id",
  "title",
  "type",
  "description",
  "price_cents",
  "image_key",
  "asset_key",
  "sort_order",
  "updated_at"
) VALUES (
  'b2f1c6d4-8e3a-4f57-9a02-1d5e7c8b9a34',
  'Le Grand Ancien',
  'asset',
  E'Le pion qui porte l''emblème de Questbook, à poser sur un plateau comme n''importe quel personnage.\n\nUtile quand la chose qui approche n''est plus tout à fait un personnage joueur, et qu''un rond de couleur ne suffit plus à dire ce que les investigateurs ont en face d''eux.',
  0,
  'logo_mark',
  'grand_ancien',
  0,
  CURRENT_TIMESTAMP
);
