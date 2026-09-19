-- CreateTable
CREATE TABLE "scenarios" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "min_recommended_players" INTEGER NOT NULL,
    "max_recommended_players" INTEGER NOT NULL,
    "average_duration_minutes" INTEGER NOT NULL,
    "rundown_markdown" TEXT NOT NULL,
    "grant_on_signup" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_annexes" (
    "id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content_markdown" TEXT NOT NULL,

    CONSTRAINT "scenario_annexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_ownerships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'grant',
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_ownerships_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "game_sessions" ADD COLUMN "scenario_id" TEXT;

-- CreateIndex
CREATE INDEX "scenario_annexes_scenario_id_sort_order_idx" ON "scenario_annexes"("scenario_id", "sort_order");

-- CreateIndex
CREATE INDEX "scenario_ownerships_user_id_idx" ON "scenario_ownerships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "scenario_ownerships_user_id_scenario_id_key" ON "scenario_ownerships"("user_id", "scenario_id");

-- AddForeignKey
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_annexes" ADD CONSTRAINT "scenario_annexes_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_ownerships" ADD CONSTRAINT "scenario_ownerships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_ownerships" ADD CONSTRAINT "scenario_ownerships_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Starter adventure, granted to every account until the shop exists.
INSERT INTO "scenarios" (
  "id",
  "title",
  "description",
  "context",
  "min_recommended_players",
  "max_recommended_players",
  "average_duration_minutes",
  "rundown_markdown",
  "grant_on_signup",
  "updated_at"
) VALUES (
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d5e',
  'Le Phare de Kerloc''h',
  'Une soirée de brume sur la côte bretonne : le gardien du phare a disparu, et les villageois jurent avoir vu la lumière clignoter en morse.',
  'Kerloc''h, 1924. Un hameau de pêcheurs au sud d''Audierne. Le phare, construit vingt ans plus tôt, guide encore les chalutiers — ou le faisait, jusqu''à mardi dernier. Le gardien, Yann Le Goff, n''a pas relevé la relève. Sa femme a télégraphié à Quimper. Les inspecteurs arrivent par la route de Pont-Croix, sous une pluie fine qui ne s''arrête plus.',
  2,
  5,
  180,
  E'## Mise en place\n\nDonner aux joueurs le télégramme (annexe 1) avant de décrire l''arrivée au village. Ils savent seulement qu''un gardien manque à l''appel.\n\n## 1. Le village\n\nLes rumours se contredisent : certains parlent d''un naufrage, d''autres d''une dette de jeu. Personne n''a vu Le Goff depuis trois jours. Sa femme, Mariette, les reçoit dans la cuisine. Elle nie avoir entendu le morse — et se trompe de date quand on insiste.\n\nUn succès en **Persuader** ou **Psychologie** lui arrache que la lumière a clignoté *après* la disparition, pas avant.\n\n## 2. Le sentier du phare\n\nUne heure de marche sur la falaise. Jet de **Nature** ou **Orientation** : des traces descendent vers une crique, pas vers le phare. Dans la crique, une barque éventrée et un carnet mouillé (annexe 2).\n\n## 3. Le phare\n\nLa porte est close, pas forcée. À l''intérieur : vaisselle propre, journal ouvert à mardi, lampe encore chaude. Le mécanisme d''optique a été calé pour émettre un motif régulier. Un succès en **Sciences** (physique) ou **Artisanat** (mécanique) identifie un message : « NE PAS ALLUMER — ILS VIENNENT PAR LA MER ».\n\nLa lanterne, si on l''allume, attire dans l''heure une forme trop longue pour un homme, qui tente de gravir la tour. Fuite, combat ou marchandage — selon ce que la table supporte.\n\n## Conclusion\n\nLe Goff n''est pas mort : il s''est caché dans la crique pour empêcher quiconque d''allumer. S''il survit à la confrontation, il peut devenir un contact. S''il meurt, Mariette hérite du secret et du phare.',
  true,
  CURRENT_TIMESTAMP
);

INSERT INTO "scenario_annexes" (
  "id", "scenario_id", "sort_order", "title", "kind", "content_markdown"
) VALUES (
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d5f',
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d5e',
  0,
  'Télégramme de Quimper',
  'handout',
  E'**POSTES ET TÉLÉGRAPHES — QUIMPER**\n\nÀ l''attention de l''inspecteur de service\n\nGARDEN PHARE KERLOC H DISPARU DEPUIS MARDI STOP FEMME ALERTE STOP LUMIERE DU PHARE SIGNALE COMPORTEMENT ANORMAL STOP PRIERE ENQUETER STOP\n\nLe Préfet du Finistère'
),
(
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d60',
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d5e',
  1,
  'Carnet de la crique',
  'clue',
  E'Pages trempées, écriture de Le Goff :\n\n> 12 mars — La lumière n''est plus à moi. Quelque chose répond, au large. J''ai compté les éclats. Ce n''est pas un alphabet que je connais, et pourtant je le comprends.\n>\n> 13 mars — Mariette ne doit pas allumer. S''ils voient la lampe, ils sauront où poser le pied. Je descends ce soir. Si je ne remonte pas, brisez le mécanisme.'
);
