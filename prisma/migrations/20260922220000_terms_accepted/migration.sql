-- Nul pour tout le monde, y compris les comptes qui existaient avant que les
-- conditions ne soient publiees : personne ne les a acceptees, et supposer
-- le contraire serait signer a leur place.
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" TIMESTAMP(3);
