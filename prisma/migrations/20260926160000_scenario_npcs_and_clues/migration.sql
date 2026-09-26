-- Un scenario n'est plus seulement un texte a lire : il porte desormais ses
-- PNJ et ses indices, que la seance qui le joue montre a son MJ.
--
-- Les annexes etaient deja cela sans le nom : tout le catalogue n'en contient
-- que de type `clue` et `handout`, c'est-a-dire des documents destines a
-- traverser l'ecran. La table est donc renommee plutot que doublee, et sa
-- colonne `kind` disparait avec la distinction qu'elle portait. Aucun
-- `map` n'a jamais ete ecrit : rien n'est perdu.
--
-- Rien ici ne copie quoi que ce soit dans une seance. Une seance lit les PNJ
-- et les indices du scenario qu'elle declare, et les corrections du catalogue
-- se voient le soir meme.

ALTER TABLE "scenario_annexes" RENAME TO "scenario_clues";
ALTER INDEX "scenario_annexes_pkey" RENAME TO "scenario_clues_pkey";
ALTER INDEX "scenario_annexes_scenario_id_sort_order_idx" RENAME TO "scenario_clues_scenario_id_sort_order_idx";
ALTER TABLE "scenario_clues" RENAME CONSTRAINT "scenario_annexes_scenario_id_fkey" TO "scenario_clues_scenario_id_fkey";
ALTER TABLE "scenario_clues" DROP COLUMN "kind";

-- CreateTable
CREATE TABLE "scenario_npcs" (
    "id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "scenario_npcs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- La seance fait partie de la cle, et c'est toute la raison d'etre de cette
-- table a cote de `session_clue_access` : le meme indice de catalogue se
-- transmet soir apres soir, a des tables differentes, a des gens differents.
CREATE TABLE "scenario_clue_access" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "clue_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_clue_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scenario_npcs_scenario_id_sort_order_idx" ON "scenario_npcs"("scenario_id", "sort_order");

-- CreateIndex
CREATE INDEX "scenario_clue_access_session_id_user_id_idx" ON "scenario_clue_access"("session_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "scenario_clue_access_session_id_clue_id_user_id_key" ON "scenario_clue_access"("session_id", "clue_id", "user_id");

-- AddForeignKey
ALTER TABLE "scenario_npcs" ADD CONSTRAINT "scenario_npcs_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_clue_access" ADD CONSTRAINT "scenario_clue_access_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_clue_access" ADD CONSTRAINT "scenario_clue_access_clue_id_fkey" FOREIGN KEY ("clue_id") REFERENCES "scenario_clues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_clue_access" ADD CONSTRAINT "scenario_clue_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Le catalogue, maintenant qu'il a ou les mettre.
--
-- Les PNJ sont ceux que le deroule nomme deja : le MJ les lisait au fil du
-- texte, il les a desormais sous la main pendant la seance. Les indices
-- ajoutes sont ceux que le deroule promet sans les ecrire — un message, un
-- registre, une etiquette — et qui manquaient le soir ou il fallait les
-- montrer.

-- Le Phare de Kerloc'h
INSERT INTO "scenario_npcs" ("id", "scenario_id", "sort_order", "name", "description") VALUES
(
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d70',
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d5e',
  0,
  'Mariette Le Goff',
  E'La femme du gardien, quarante ans, reçoit dans sa cuisine sans jamais s''asseoir.\n\nElle a télégraphié à Quimper et elle le regrette déjà. Elle nie avoir entendu le morse, et se trompe de date dès qu''on insiste : **Psychologie** ou **Persuader** lui arrache que la lumière a clignoté *après* la disparition.\n\nElle sait que son mari est vivant. Elle ne dira pas où tant qu''un investigateur parlera d''allumer la lanterne.'
),
(
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d71',
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d5e',
  1,
  'Yann Le Goff',
  E'Le gardien disparu, cinquante-deux ans, terré dans la crique depuis mardi avec une barque éventrée et trois jours de pluie sur le dos.\n\nIl n''est ni mort ni fou : il a compris que la lampe sert à désigner la côte, et il est descendu casser ce qu''il pouvait. Il parlera volontiers, à condition qu''on ne remonte pas allumer.\n\nS''il survit à la confrontation, il devient un contact pour la suite. S''il meurt, Mariette hérite du phare et du secret.'
),
(
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d72',
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d5e',
  2,
  'Le père Kerdraon',
  E'Patron du café du port, soixante-dix ans, sert et écoute.\n\nC''est lui qui tient les rumeurs : le naufrage, la dette de jeu, la maîtresse de Douarnenez. Les trois sont fausses, et il les répète sans y croire pour voir qui les prend au sérieux.\n\nIl se souvient d''une relève manquée en 1911, et d''un gardien qu''on avait retrouvé sur la grève « avec de l''eau dans les yeux ». Il ne l''expliquera pas davantage.'
);

INSERT INTO "scenario_clues" ("id", "scenario_id", "sort_order", "title", "content_markdown") VALUES
(
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d73',
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d5e',
  2,
  'Le journal du phare, à la date de mardi',
  E'*Registre officiel, colonne « observations », écriture appliquée puis hâtive.*\n\n> **Mardi 13.** Vent d''ouest, 5. Visibilité 4 milles. Relève assurée à 6 h.\n>\n> 21 h — Réponse au large. Trois éclats, pause, trois éclats. Ce n''est pas un navire : rien ne bouge entre les éclats.\n>\n> 23 h — J''ai coupé. Il a continué.\n\nLe reste de la page est vierge, et la suivante a été arrachée.'
),
(
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d74',
  '7c4e9b10-2a1f-4d8e-9c3b-0f1a2b3c4d5e',
  3,
  'Le motif de l''optique',
  E'*À remettre au joueur qui réussit **Sciences** (physique) ou **Artisanat** (mécanique) devant le mécanisme calé.*\n\nLes cames ont été limées pour émettre autre chose que le feu réglementaire. Transcrit, le motif donne :\n\n> ▪▪▪ ▬ ▪ ▪▬▪▪ ▬▪ ▪▬▬▪ ▪▬ ▪▬▪▪\n>\n> **« NE PAS ALLUMER — ILS VIENNENT PAR LA MER »**\n\nLe limage est frais. Il a été fait de l''intérieur, par quelqu''un qui connaissait la machine.'
);

-- Le Dernier Train de Nuit
INSERT INTO "scenario_npcs" ("id", "scenario_id", "sort_order", "name", "description") VALUES
(
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1ca0',
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c95',
  0,
  'Le contrôleur Boileau',
  E'Vingt-deux ans de ligne, la clé de toutes les cabines et l''air de quelqu''un qui préférerait être ailleurs.\n\nIl a déjà vu ça, il y a quatre ans, sur cette ligne, et il n''en a jamais fait rapport : la compagnie l''aurait remercié. Il ne le racontera qu''à qui lui aura payé un verre au wagon-restaurant, et seulement une fois le train reparti de Mâcon.\n\nIl compte les essieux à chaque arrêt, par habitude, dit-il.'
),
(
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1ca1',
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c95',
  1,
  'Madame Ferrand, cabine 5',
  E'Veuve de Lyon, voyage avec un chien qui refuse de dormir.\n\nElle dit avoir dormi ; **Psychologie** la prend en défaut. Elle a entendu quelqu''un réciter, à voix basse, longtemps, dans une langue qu''elle n''a pas reconnue — et une seconde voix qui répondait à contretemps, du côté de la fenêtre.\n\nElle n''ouvrira pas sa porte après Mâcon, quoi qu''on lui promette.'
),
(
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1ca2',
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c95',
  2,
  'Étienne Vaugelas',
  E'Le passager de la cabine 7, que personne n''a vu descendre.\n\nOn le retrouve sur le toit du wagon après Mâcon, assis, intact, sans un cheveu dérangé par le vent — qui ne le touche pas. Il parle à ce qui suit le convoi depuis Laroche, et cela lui répond.\n\nIl propose aux investigateurs de faire demi-tour, poliment, et **il sait pourquoi chacun d''eux a pris ce train-là**. Se servir ici de ce que les joueurs ont répondu à la mise en place.'
),
(
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1ca3',
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c95',
  3,
  'Le passager de la cabine 9',
  E'N''existe pas, et c''est là tout le personnage.\n\nLe registre porte un nom — *M. Aubertin, Paris-Marseille, aller simple* —, la cabine est vide, faite au carré, et aucun voyageur ne se souvient de l''avoir vue occupée. Boileau jurera l''avoir poinçonné.\n\nÀ jouer comme une absence : une porte qui se referme au bout du couloir, un nom que quelqu''un prononce sans savoir pourquoi. Ne jamais le montrer.'
);

INSERT INTO "scenario_clues" ("id", "scenario_id", "sort_order", "title", "content_markdown") VALUES
(
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1ca4',
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c95',
  2,
  'Registre de la voiture 4',
  E'*Feuille du contrôleur, colonnes à l''encre violette.*\n\n| Cabine | Voyageur | Trajet |\n| --- | --- | --- |\n| 5 | Ferrand, Hortense (Mme) | Paris — Lyon |\n| 6 | Bréant, Julien | Paris — Dijon |\n| 7 | Vaugelas, Étienne | Paris — Marseille |\n| 8 | *libre* | — |\n| 9 | Aubertin, M. | Paris — Marseille |\n| 10 | Pasquier, Aline (Mlle) | Paris — Valence |\n\nEn bas de page, au crayon, d''une autre main : « *43 billets, 44 lits faits.* »'
),
(
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1ca5',
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c95',
  3,
  'Le compte des essieux',
  E'*À remettre à qui suit Boileau sur le quai, à Dijon ou à Mâcon.*\n\nIl marche le long du convoi en frappant chaque essieu d''un petit marteau, et compte à voix haute. Le compte ne tombe jamais juste.\n\n> Paris : quarante-huit.\n> Laroche : quarante-huit.\n> Dijon : cinquante.\n> Mâcon : cinquante.\n\n« Deux essieux de plus, et pas un wagon de plus. Vous me direz où ils sont, vous. »'
);

-- L'Herbier de Madame Sauvel
INSERT INTO "scenario_npcs" ("id", "scenario_id", "sort_order", "name", "description") VALUES
(
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e80',
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e70',
  0,
  'Lucienne Marchand',
  E'La nièce, unique héritière de la maison et de rien d''autre : l''herbier va au muséum, et elle le prend mal.\n\nElle veut que tout parte avant la fin de la semaine, et rôde pendant l''inventaire. Elle ouvrira elle-même le carton du fond si on la laisse seule avec, par curiosité, puis par entêtement.\n\nElle n''a jamais vu sa tante herboriser. Elle l''a vue rentrer, une fois, en juin 1919, et n''en parle qu''à qui ne le lui demande pas.'
),
(
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e81',
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e70',
  1,
  'Augustin Bard',
  E'Pharmacien de Salins, soixante-dix-huit ans, se souvient très bien d''Hortense Sauvel et refuse d''en parler.\n\nIl cède contre une seule promesse : que le carton soit brûlé. Il raconte alors la combe, au-dessus de Chapois, où la neige fond trois semaines trop tôt — et il donne le chemin, à contrecœur, en répétant qu''il n''y montera pas.\n\nIl a reçu onze lettres d''Hortense entre mars et juin 1919. Il n''a répondu qu''à dix.'
),
(
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e82',
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e70',
  2,
  'Ce qui pousse dans la combe',
  E'Pas un monstre : un versant en fleurs au mauvais mois, et une attention.\n\nRien n''attaque, rien ne poursuit. Ce qui s''y trouve reprend, chez celui qui s''attarde, la forme des plantes qu''il connaît le mieux — un jet de **Santé mentale** pour l''investigateur qui s''en aperçoit avant de redescendre, et rien du tout pour celui qui ne s''aperçoit de rien.\n\nLa combe ne se retrouve pas deux fois par le même chemin. Le laisser constater, ne jamais l''expliquer.'
);

INSERT INTO "scenario_clues" ("id", "scenario_id", "sort_order", "title", "content_markdown") VALUES
(
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e83',
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e70',
  2,
  'Étiquette de la planche n° 11',
  E'*Papier gommé, écriture minuscule, collé au bas de la planche.*\n\n> **Herbier H. SAUVEL**\n>\n> N° 11 — *det. impossible*\n> Localité : combe sans nom, au-dessus de Chapois, exp. N.\n> Altitude : 780 m.\n> Récolte : **14 juin 1919**.\n>\n> *Floraison observée : février, mai, septembre. Trois fois la même année.*\n\nLes dix autres étiquettes portent la même localité. Aucune ne porte la même date.'
),
(
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e84',
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e70',
  3,
  'Lettre à Augustin Bard, non envoyée',
  E'*Trouvée dans la correspondance interrompue, pliée, jamais mise sous enveloppe.*\n\n« Mon cher Augustin,\n\nVous m''écrivez que je devrais redescendre et je vous réponds que j''y suis, chez moi, à Nozeroy, depuis onze jours.\n\nSeulement voilà : le versant nord est visible de ma fenêtre, ce qui est impossible, il y a quarante kilomètres et deux vallées.\n\nNe venez pas. Vous la verriez, et vous, vous sauriez le chemin. »\n\nLa lettre n''est pas signée.'
);
