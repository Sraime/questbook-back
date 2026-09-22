-- Un compte se connecte par Google ou par Apple, jamais par les deux : Apple
-- ne livre l'adresse qu'a la premiere autorisation, et le plus souvent
-- derriere un relais prive, donc rien ne permet de rapprocher le meme humain
-- d'un fournisseur a l'autre.
--
-- `google_sub` cesse donc d'etre obligatoire. Les comptes existants en ont
-- tous un, la colonne reste unique, et c'est l'API qui refuse un compte sans
-- aucun des deux : Postgres ne sait pas exprimer « l'un ou l'autre » sur une
-- contrainte d'unicite.
ALTER TABLE "users" ALTER COLUMN "google_sub" DROP NOT NULL;

ALTER TABLE "users" ADD COLUMN "apple_sub" TEXT;

CREATE UNIQUE INDEX "users_apple_sub_key" ON "users"("apple_sub");
