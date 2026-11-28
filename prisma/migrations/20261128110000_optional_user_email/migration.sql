-- Un compte Apple peut ne pas partager son adresse.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
