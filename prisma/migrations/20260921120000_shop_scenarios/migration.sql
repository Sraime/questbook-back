-- Deux aventures à vendre, et les articles qui les donnent.
--
-- `grant_on_signup` reste faux : ce sont les premières que la boutique ait à
-- offrir, et les donner à l'inscription reviendrait à n'avoir rien à vendre.
-- Leur prix est de zéro, comme tout le reste du rayon tant que le paiement
-- n'existe pas — `ShopService.purchase` refuse un article payant.

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
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c95',
  'Le Dernier Train de Nuit',
  E'Un wagon-lit entre Paris et Marseille, une porte fermée de l''intérieur, et un passager qui n''est jamais descendu. Huis clos en marche, pour une soirée.',
  E'Gare de Lyon, novembre 1926, 21 h 40. Le rapide de nuit part avec douze minutes de retard et quarante-trois voyageurs. À Dijon, le contrôleur constate que la cabine 7 est verrouillée de l''intérieur et que son occupant, un certain Étienne Vaugelas, n''a pas répondu depuis Laroche-Migennes. La compagnie préfère éviter la gendarmerie : un scandale sur la ligne de Marseille coûterait plus cher qu''un homme. Les investigateurs voyagent dans le même wagon, pour leurs propres raisons.',
  3,
  5,
  210,
  E'## Mise en place\n\nDemander à chaque joueur pourquoi son investigateur prend ce train-là, cette nuit-là. La réponse servira à la scène 3 : quelqu''un, à bord, connaît déjà ce motif.\n\nDonner le billet (annexe 1) et laisser le contrôleur frapper à la porte de la cabine 7.\n\n## 1. La cabine 7\n\nLa porte cède au pied-de-biche. Personne. La couchette est faite, la valise ouverte, la fenêtre close et bloquée par la sécurité d''origine — un jet de **Artisanat** (mécanique) confirme qu''elle n''a pas été forcée. Sur la tablette : un verre d''eau encore froid, et un carnet ouvert au milieu d''une phrase (annexe 2).\n\nUn succès en **Trouver objet caché** révèle, sous la couchette, de la suie fraîche. Il n''y a pas de cheminée dans un wagon-lit.\n\n## 2. Le wagon, de bout en bout\n\nQuarante-deux voyageurs à interroger, et trois qui mentent :\n\n- **Mme Ferrand**, cabine 5, dit avoir dormi. Un jet de **Psychologie** la prend en défaut : elle a entendu quelqu''un réciter quelque chose, à voix basse, pendant longtemps.\n- **Le contrôleur Boileau** a déjà vu ça, il y a quatre ans, sur la même ligne. Il ne le dira qu''à qui lui aura payé un verre au wagon-restaurant.\n- **Le passager de la cabine 9** n''existe pas : le registre porte un nom, la cabine est vide et propre, et personne ne se souvient de l''avoir vue occupée.\n\n## 3. Entre deux gares\n\nÀ partir de Mâcon, le train ne ralentit plus aux signaux. Les fenêtres ne montrent plus de lumières. Un investigateur qui descend sur le marchepied à l''arrêt suivant ne retrouve pas le quai.\n\nLa suie mène au toit. Vaugelas y est, assis, intact, et parle à quelque chose qui suit le convoi depuis Laroche. Il propose aux investigateurs de faire demi-tour — et il sait pourquoi chacun a pris ce train.\n\n## Conclusion\n\nLe train arrive à Marseille à l''heure, avec quarante-trois voyageurs. Le registre en compte quarante-quatre. Aucune version n''est fausse : c''est ce qui rend l''affaire inclassable, et ce qui la fera rouvrir.',
  false,
  CURRENT_TIMESTAMP
);

INSERT INTO "scenario_annexes" (
  "id", "scenario_id", "sort_order", "title", "kind", "content_markdown"
) VALUES (
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c96',
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c95',
  0,
  'Billet de wagon-lit',
  'handout',
  E'**COMPAGNIE INTERNATIONALE DES WAGONS-LITS**\n\nParis-Lyon — Marseille-Saint-Charles\n\nDépart : 21 h 28. Voiture 4. Cabine ___.\n\n*Le voyageur est prié de ne pas ouvrir sa porte entre les arrêts.*'
), (
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c97',
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c95',
  1,
  'Le carnet de Vaugelas',
  'clue',
  E'*Les trois dernières pages, d''une écriture qui se dégrade.*\n\n« Laroche. Il monte toujours à Laroche. »\n\n« Compté les essieux : quarante-huit à Paris, cinquante à Dijon. Personne ne trouve cela étrange. »\n\n« Ne pas répondre quand il donne le nom. Surtout ne pas répondre quand c''est le'
);

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
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e70',
  E'L''Herbier de Madame Sauvel',
  E'Une botaniste du Jura meurt en léguant six mille planches séchées. Onze d''entre elles portent des plantes qui n''existent pas. Enquête lente, pour une table qui aime fouiller.',
  E'Nozeroy, printemps 1923. Hortense Sauvel a herborisé le plateau jurassien pendant quarante ans et légué sa collection au muséum de Besançon, qui envoie quelqu''un l''inventorier. La maison est froide, les volets tirés, et la nièce de la défunte veut que tout parte vite. Les onze planches en question ne sont pas égarées au milieu des autres : elles sont rangées ensemble, à la fin, dans un carton que personne n''a ouvert depuis 1919.',
  2,
  4,
  240,
  E'## Mise en place\n\nUn investigateur au moins doit avoir une raison d''être là : le muséum, le notaire, la famille. Les autres l''accompagnent. Donner l''extrait d''inventaire (annexe 1) dès l''arrivée.\n\n## 1. La maison de Nozeroy\n\nSix mille planches, classées à la perfection jusqu''à la lettre S. Après, l''ordre se défait. Un jet de **Bibliothèque** sur une journée de travail sort trois choses : un cahier de terrain qui saute l''année 1919, une correspondance interrompue avec un pharmacien de Salins, et le carton du fond.\n\n**Botanique** ou **Sciences naturelles** sur les onze planches : la nervation est cohérente, la floraison impossible, et aucune ne figure dans aucune flore. Elles ne sont pas fabriquées. Elles ont poussé.\n\n## 2. Le pharmacien de Salins\n\nAugustin Bard, 78 ans, se souvient très bien d''Hortense Sauvel et refuse d''en parler. Il cède contre la promesse que le carton sera brûlé. Il raconte alors la combe : une vallée fermée, au-dessus de Chapois, où la neige fond trois semaines trop tôt.\n\n## 3. La combe\n\nQuatre heures de marche. La combe existe, les cartes de l''état-major ne la portent pas. Ce qui y pousse correspond aux onze planches, en plus grand.\n\nCe n''est pas hostile. C''est attentif. Et cela reprend, chez qui s''y attarde, la forme des plantes qu''il connaît le mieux — un jet de **Santé mentale** pour qui s''en rend compte avant de redescendre.\n\n## Conclusion\n\nLe muséum acceptera l''herbier sans les onze planches, dont il niera avoir jamais reçu l''annonce. La combe, elle, ne se retrouve pas deux fois par le même chemin.',
  false,
  CURRENT_TIMESTAMP
);

INSERT INTO "scenario_annexes" (
  "id", "scenario_id", "sort_order", "title", "kind", "content_markdown"
) VALUES (
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e71',
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e70',
  0,
  E'Extrait d''inventaire',
  'handout',
  E'**MUSÉUM DE BESANÇON — FONDS SAUVEL**\n\nPlanches recensées : 6 014.\n\nPlanches sans détermination : 11, réunies en un carton portant la mention manuscrite « *combe — ne pas classer* ».\n\n*Prière de signaler toute planche dont l''étiquette porte une date postérieure à 1919.*'
), (
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e72',
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e70',
  1,
  'Cahier de terrain, page arrachée',
  'clue',
  E'*Retrouvée pliée dans la reliure, écriture d''Hortense Sauvel.*\n\n« 14 juin. Remontée seule. Le versant nord est en fleurs, ce qui est absurde.\n\nJ''ai prélevé onze pieds. Je n''ai pas pu en prélever douze : le douzième s''est refermé.\n\nNe pas y retourner avec Augustin. Il la verrait. »'
);

-- Les articles. `image_key` nomme un dessin que l'app résout ; « scroll »
-- est le glyphe qu'elle donne à une aventure, faute d'illustration.
INSERT INTO "shop_items" (
  "id",
  "title",
  "type",
  "description",
  "price_cents",
  "image_key",
  "asset_key",
  "scenario_id",
  "sort_order",
  "updated_at"
) VALUES (
  'd9e0f1a2-3b4c-4d5e-8f60-1a2b3c4d5e6f',
  'Le Dernier Train de Nuit',
  'scenario',
  E'Un wagon-lit entre Paris et Marseille, une porte fermée de l''intérieur, et un passager qui n''est jamais descendu. Huis clos en marche : trois à cinq investigateurs, une soirée, et quarante-trois voyageurs dont un de trop.',
  0,
  'scroll',
  NULL,
  'a1d3f5e7-9b20-4c61-8f43-2e6d0a7b1c95',
  1,
  CURRENT_TIMESTAMP
), (
  'e0f1a2b3-4c5d-4e6f-9a71-2b3c4d5e6f70',
  E'L''Herbier de Madame Sauvel',
  'scenario',
  E'Une botaniste du Jura meurt en léguant six mille planches séchées, dont onze portent des plantes qui n''existent pas. Enquête lente et documentaire pour deux à quatre investigateurs, à mener sur une longue soirée.',
  0,
  'scroll',
  NULL,
  'c4b8e2a1-7d36-4f09-9e52-3a1c8b5d4e70',
  2,
  CURRENT_TIMESTAMP
);
