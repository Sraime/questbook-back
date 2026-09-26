# Questbook — API

Backend de [questbook-app](https://github.com/Sraime/questbook-app) : connexion
via un compte Google, persistance des personnages (caractéristiques,
compétences, ressources, inventaire) sur un compte utilisateur, et gestion des
tables de jeu — membres, invitations par e-mail, sessions et notifications.

**Node.js 22 · Fastify 5 · Prisma 6 · PostgreSQL 17 · TypeScript**

> Ce que désignent **table**, **session**, **scénario**, **asset** ou
> **boutique** est défini une fois pour toutes dans le
> [lexique](../questbook-ia/LEXIQUE.md), commun à l'API et à l'app. Ce README
> décrit comment c'est fait ; le lexique dit ce que c'est.

UI et documentation en **français**, code et commentaires en **anglais**
(même convention que l'app Flutter).

---

## Sommaire

- [Architecture](#architecture)
- [Modèle de données](#modèle-de-données)
- [Authentification](#authentification)
- [Le backoffice](#le-backoffice)
- [Endpoints](#endpoints)
- [Tables, sessions et notifications](#tables-sessions-et-notifications)
- [Synchronisation](#synchronisation)
- [Développement local](#développement-local)
- [Configuration Google Cloud](#configuration-google-cloud)
- [Déploiement sur le VPS](#déploiement-sur-le-vps)
- [Tests](#tests)

---

## Architecture

```
src/
├── index.ts                  point d'entrée : charge la config, démarre le serveur
├── app.ts                    construction de l'instance Fastify (plugins, routes, erreurs)
├── admin.ts                  point d'entrée du backoffice — voir plus bas
├── admin/
│   ├── app.ts                la seconde instance Fastify, celle de l'administration
│   ├── audit.ts              `recordAudit` : ce que l'administration a fait
│   ├── auth/                 connexion par mot de passe et TOTP
│   ├── reports/              la file des signalements
│   ├── scenarios/            écrire et corriger le catalogue
│   ├── users/                suspendre, lever, fermer un compte
│   └── plugins/admin-auth.ts `app.requireAdmin`, la garde du backoffice
├── config/env.ts             validation zod des variables d'environnement
│
│  (et, hors de `src/`, `admin-web/` : le front local du backoffice)
├── lib/
│   ├── errors.ts             AppError + helpers (badRequest, notFound, conflict…)
│   ├── fastify-errors.ts     le gestionnaire d'erreurs, partagé par les deux API
│   ├── tokens.ts             jetons opaques et leur empreinte SHA-256
│   ├── password.ts           hachage scrypt, pour les seuls comptes d'administration
│   ├── totp.ts               second facteur RFC 6238
│   ├── email-sender.ts       interface EmailSender + implémentation Resend
│   └── push-sender.ts        interface PushSender + implémentation FCM HTTP v1
├── plugins/
│   ├── prisma.ts             connexion PostgreSQL, décorée sur `app.prisma`
│   ├── auth.ts               JWT, AuthService, garde `app.authenticate`
│   └── messaging.ts          `app.email` et `app.notifications`
└── modules/
    ├── auth/                 vérification Google, émission/rotation des jetons
    ├── characters/           schémas zod, service métier, routes REST
    ├── tables/               tables, membres, invitations, sessions
    └── notifications/        historique in-app et jetons d'appareil
```

Trois principes structurent le code :

1. **Les services ne connaissent pas Fastify.** `AuthService` reçoit une
   fonction de signature et un vérificateur Google en paramètres, ce qui permet
   de les remplacer par des doublures dans les tests sans monter de serveur HTTP
   factice.
2. **La validation est déclarative.** Chaque route déclare ses schémas zod
   (`params`, `querystring`, `body`) ; une requête malformée n'atteint jamais le
   service.
3. **Le personnage est un agrégat.** Stats, ressources et inventaire n'existent
   pas indépendamment de leur personnage et sont remplacés en bloc lors d'une
   synchronisation.

### Gestion des erreurs

`installErrorHandling` traduit tout en `{ "error": { "code", "message" } }`, et
sert **les deux API** : deux copies divergeraient, et un client qui a appris
une forme d'erreur en rencontrerait une autre.

> ⚠️ Il est installé **avant** les `register` de routes. Fastify fige le
> gestionnaire d'erreurs au moment où chaque contexte encapsulé est créé : un
> `setErrorHandler` appelé après les `register` ne s'appliquerait jamais aux
> routes déjà enregistrées (piège déjà rencontré ici, 3 tests rouges à la clé).

### Corps JSON vide

Un parseur `application/json` maison lit un corps vide comme une absence de
corps, là où celui de Fastify répond `400 FST_ERR_CTP_EMPTY_JSON_BODY`.

Dio, le client HTTP de l'app, estampille **toutes** ses requêtes
`application/json`, corps ou pas, sans moyen de s'en passer au cas par cas.
Sans cette tolérance, chaque appel sans corps — annuler une session, quitter
une table, décliner une invitation — mourait avant d'atteindre son handler.

Rien n'est perdu côté rigueur : les routes qui attendent un corps déclarent un
schéma, et un corps absent le viole tout aussi bruyamment.

---

## Modèle de données

Les identifiants de personnages sont **générés par le client Flutter** (Drift
utilise déjà des UUID v4) et réutilisés tels quels côté serveur : un personnage
garde une identité unique sur tous les appareils, sans table de correspondance.

| Table                 | Rôle                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `users`               | Compte, lié à un `google_sub` unique                              |
| `refresh_tokens`      | Sessions, stockées **hachées** (SHA-256)                          |
| `characters`          | Racine d'agrégat, avec `updated_at` et tombstone `deleted_at`     |
| `character_stats`     | Caractéristiques, compétences et attributs (`kind`)               |
| `character_resources` | PV / SAN / PM (`current`, `max`, `tone`)                          |
| `inventory_items`     | Objets (`name`, `qty`, `weight`)                                  |
| `game_tables`         | Table de jeu : titre, MJ propriétaire (`universe_label` : hérité) |
| `table_members`       | Appartenance et rôle (`gm` / `player`)                            |
| `table_invitations`   | Invitations, jeton stocké **haché** comme les refresh tokens      |
| `game_sessions`       | Séance : titre, description, date/heure, lieu, statut, scénario optionnel |
| `session_attendances` | Réponses des joueurs (`yes` / `no`) et personnage joué, exigé pour un `yes` |
| `scenarios`           | Catalogue de scénarios, écrits côté serveur (pas par les joueurs) |
| `scenario_npcs`       | Les PNJ qu'un scénario livre avec lui                             |
| `scenario_clues`      | Les indices qu'un scénario livre avec lui (ex-`scenario_annexes`) |
| `scenario_clue_access`| Qui, **dans quelle séance**, a reçu un indice du catalogue        |
| `session_boards`      | La carte et les pions d'une session, tels que le MJ les a poussés   |
| `scenario_ownerships` | Qui possède un scénario (`grant` à la connexion, `purchase` depuis la boutique) |
| `shop_items`          | Catalogue de la boutique : titre, type, description, prix, clés d'image et d'asset |
| `shop_item_ownerships`| Qui a acheté quoi                                                 |
| `device_tokens`       | Jetons FCM, un par appareil                                       |
| `notifications`       | Historique consultable dans l'app                                 |
| `reports`             | Signalements, leur instantané du contenu, et ce qu'en a décidé le support |
| `user_blocks`         | Qui a bloqué qui, à sens unique                                   |
| `admin_users`         | Les comptes du [backoffice](#le-backoffice). Aucun lien vers `users` |
| `admin_sessions`      | Sessions d'administration, jeton stocké **haché**, révocables     |
| `admin_audit_log`     | Ce que l'administration a fait, et les tentatives pour y entrer   |

Les champs des personnages reproduisent exactement les modèles Freezed de l'app
(`Character`, `CharacterStat`, `CharacterResource`, `InventoryItem`). Les
tables, elles, n'ont pas d'équivalent local : elles sont partagées entre
plusieurs comptes et ne vivent que sur le serveur. Les scénarios, volumineux,
sont listés depuis l'API puis téléchargés sur l'appareil pour la lecture hors
ligne ; un utilisateur ne voit que ceux qu'il possède.

---

## Authentification

Le flux évite de faire transiter un mot de passe ou de gérer un
redirect OAuth côté serveur :

```
App Flutter                    API Questbook                 Google
    │                                │                          │
    │ 1. google_sign_in ─────────────┼─────────────────────────▶ │
    │ ◀──────────────────────────────┼── ID token (JWT signé) ── │
    │                                │                          │
    │ 2. POST /auth/google           │                          │
    │    { idToken } ───────────────▶│                          │
    │                                │ 3. vérifie signature,    │
    │                                │    issuer et audience ──▶ │
    │                                │                          │
    │ ◀── accessToken + refreshToken │                          │
    │     + profil utilisateur       │                          │
```

- L'**access token** est un JWT HS256 signé par l'API, valable 15 minutes.
- Le **refresh token** est une chaîne aléatoire opaque (48 octets), valable
  30 jours, **stockée hachée** en base et **tournée à chaque usage** : un jeton
  volé n'est utilisable qu'une seule fois, et sa réutilisation est rejetée.
- L'inscription et la connexion sont le **même appel** : le premier ID token
  d'un compte Google crée l'utilisateur, les suivants rafraîchissent son profil.
- Tout se rafraîchit depuis Google **sauf le pseudo** : Google donne le
  premier, ensuite il appartient à Questbook et ne change plus que par
  `PATCH /auth/me`. Le remettre dans le `update` de l'`upsert` renommerait
  silencieusement, à sa connexion suivante, quiconque s'est choisi un nom ici.
- Un email non vérifié par Google est refusé.
- L'**access token** ne porte que `sub` (l'identifiant interne). L'email
  reste dans `/auth/me` et dans la réponse de connexion, destinés au seul
  compte connecté.

### Connexion Apple

`POST /auth/apple` est la même porte, pour le fournisseur qu'Apple impose à
toute app dont la seule connexion est un service tiers (guideline 4.8 : Google
Sign-In ne permet pas de masquer son adresse, donc il n'y suffit pas). Le
client envoie l'`identityToken` obtenu sur l'appareil, l'API en vérifie la
signature contre le JWKS `https://appleid.apple.com/auth/keys`, puis rend la
même paire de jetons.

La vérification est écrite à la main dans `apple-verifier.ts`, sur `node:crypto`
plutôt que sur une bibliothèque JWT : une signature RS256, un émetteur, une
audience et une expiration, c'est tout ce qu'Apple demande de contrôler.
Le jeu de clés est gardé une heure en cache, et un `kid` inconnu force un
nouveau téléchargement — c'est la forme normale d'une rotation, qu'Apple
n'annonce pas.

Trois différences avec Google, toutes dictées par le jeton :

- **Il ne porte ni nom ni photo.** Apple ne remet le nom qu'une fois, au
  client, à la première autorisation. C'est donc lui qui le passe dans
  `displayName`, et on ne lui fait pas plus confiance qu'au renommage : le
  joueur peut le changer ensuite, c'est tout ce que ce champ vaut.
- **L'adresse peut manquer**, si le compte a été autorisé sans la partager.
  Une table s'invite par adresse : la connexion répond alors `400` en le
  disant, plutôt que de fabriquer une adresse interne.
- **Rien ne se rafraîchit ensuite.** Les connexions suivantes ne portent que le
  `sub`, et c'est par lui que le compte se retrouve — jamais par l'email.

`google_sub` et `apple_sub` sont deux colonnes nullables, uniques, et un compte
n'en porte qu'une. **Il n'y a pas de fusion** : la même personne connectée par
Apple après l'avoir été par Google obtient un second compte. Le relais privé
`@privaterelay.appleid.com` rend les deux adresses étrangères l'une à l'autre,
et rien dans les jetons ne dit qu'il s'agit du même humain. Si l'adresse
partagée est en revanche celle d'un compte Google existant, la connexion répond
`409` en nommant la collision, plutôt que de tomber sur la contrainte
d'unicité.

`APPLE_CLIENT_IDS` peut rester vide, là où `GOOGLE_CLIENT_IDS` est obligatoire :
une API qui refuserait de démarrer faute de cette variable couperait la
connexion Google avec. Vide, elle fait répondre `401` à la connexion Apple en
le disant, et le démarrage l'écrit dans les logs.

### Supprimer un compte

`DELETE /auth/me` est un `user.delete` sec. Toutes les relations vers `User`
sont en `onDelete: Cascade`, si bien qu'une seule instruction emporte les
personnages, les réponses aux sessions, les notifications, les achats et les
jetons de rafraîchissement.

**Elle emporte aussi les tables que le compte animait**, et avec elles les
sessions, les invitations et l'appartenance de leurs joueurs. C'est un choix
assumé plutôt qu'un oubli : `GameTable.ownerId` est en cascade, une table sans
MJ serait une salle morte, et `transferGameMaster` exige justement un MJ pour
transmettre — il n'y a donc personne pour le faire à sa place. L'application
prévient avant d'appeler, en nommant le nombre de tables concernées.

Les autres joueurs, eux, ne sont prévenus de rien : leurs notifications
appartiennent à la table, qui vient de disparaître. Si cela devient gênant,
c'est un `SetNull` sur `ownerId` qu'il faudra envisager, pas un correctif ici.

---

## Données personnelles

Questbook stocke deux identifiants nominatifs par compte : **l'email Google**
(unique, en clair — il sert à retrouver un joueur pour l'inviter) et le
**nom affiché** Google. Ce sont des données personnelles ; le reste du modèle
(personnages, tables, sessions) n'en contient pas, hors copies de l'email sur
une invitation en cours.

Ce que le code garantit :

- **TLS jusqu'à Caddy.** PostgreSQL et l'API ne publient aucun port ; ils
  restent sur le réseau Docker interne. UFW n'ouvre que 2222 / 80 / 443.
- **Minimisation de l'API.** Un membre de table voit son propre email et le
  nom des autres, jamais leur boîte. Un joueur sans nom Google s'affiche
  « Joueur », pas `quelquun@…`. Le JWT ne contient plus l'email.
- **Journaux.** Pino masque jetons, `Authorization` et `req.body.email`. Un
  404 n'échoe plus l'URL (un lien d'invitation y porterait un jeton). Caddy
  filtre `/invitations/…` de la même façon. Sans `RESEND_API_KEY`, l'expéditeur
  de secours journalise le sujet, pas le destinataire ni le corps.
- **Jetons.** Refresh tokens et jetons d'invitation sont stockés **hachés**
  (SHA-256). `.env` est créé avec `umask 077` sur le VPS.

### Les trois pages que les stores exigent

Ni Play ni l'App Store ne publient une fiche sans URL de politique de
confidentialité ; Play en réclame une seconde décrivant la suppression du
compte ; et la directive 1.2 d'Apple, qui s'applique dès qu'une app affiche
du contenu écrit par ses utilisateurs, en attend une troisième — des
conditions d'utilisation disant que le contenu choquant n'est pas toléré.
Elles sont servies par Caddy, sur le domaine de l'API :

| Page | Fichier |
| --- | --- |
| <https://questbook.nextuscorp.com/confidentialite> | `web/confidentialite.html` |
| <https://questbook.nextuscorp.com/suppression-du-compte> | `web/suppression-du-compte.html` |
| <https://questbook.nextuscorp.com/conditions-utilisation> | `web/conditions-utilisation.html` |

Pas de site à part : le certificat est déjà là, et un second domaine serait
une échéance de plus à oublier. Le `Caddyfile` les sert depuis `/srv/web`
avant de passer la main au reverse proxy, si bien qu'`/api/v1/*` n'est pas
touché. Ajouter une page demande donc deux gestes — le fichier dans `web/`,
et son chemin dans le matcher `@pages`.

**Ce qu'elles annoncent doit rester vrai.** La politique décrit des journaux
gardés dans un tampon de taille limitée : c'est la rotation déclarée par
l'ancre `x-journaux` de `docker-compose.yml` (10 Mo, trois fichiers, par
service) qui la rend exacte. Sans elle, le pilote par défaut garderait tout
tant que le conteneur vit — et Caddy tourne des semaines d'affilée. Modifier
l'une sans l'autre transforme la page en fausse déclaration.

Les conditions annoncent de leur côté un examen des signalements **sous
vingt-quatre heures** et la fermeture du compte fautif. C'est un engagement
tenu à la main, depuis la boîte `REPORTS_EMAIL_TO` : rien dans le code ne
l'applique, et rien ne préviendra s'il ne l'est pas.

Ce qui reste une affaire d'exploitation, pas de code (voir aussi le VPS) :

- chiffrement du disque du VPS et des sauvegardes du volume Postgres ;
- DPA Resend, avant une ouverture publique.

---

## Le backoffice

Une **seconde application Fastify**, montée par `buildAdminApp`, démarrée par
`src/admin.ts`, servie par la même image Docker et la même base. C'est de là
que se suivent les signalements, se modère et s'administre le contenu.

Elle est séparée parce que les deux API font l'inverse l'une de l'autre :
chaque route de l'API produit enferme un compte dans ses propres données,
chaque route du backoffice lit à travers tous les comptes. Partager un
écouteur, ce serait partager une surface, et une seule route mal gardée
mettrait tout le catalogue de données personnelles à un bug d'authentification.

**Mais elles partagent le dépôt, le schéma Prisma et l'image**, volontairement.
Deux copies du modèle finissent toujours par diverger, et ce projet a déjà une
règle entière sur le jour où l'app est partie devant son backend.

### Elle n'est pas sur Internet

Caddy ne la connaît pas : pas de bloc de site, pas de sous-domaine, pas de
certificat de plus à renouveler. Le conteneur publie sur la **boucle locale du
VPS**, et rien d'autre :

```yaml
ports:
  - '127.0.0.1:4000:4000'
```

> Cette ligne est toute la sécurité du backoffice. Un `4000:4000` nu publierait
> sur toutes les interfaces, en écrivant directement dans netfilter — donc
> **sans que UFW ne l'indique nulle part**, comme le rappelle déjà la section
> Firewall. Le préfixe n'est pas décoratif.

On y accède par un tunnel SSH, sur la clé et le port qui servent déjà au
déploiement :

```powershell
ssh -i "$env:USERPROFILE\.ssh\questbook_vps_ed25519" -p 2222 `
  -N -L 4000:127.0.0.1:4000 debian@151.80.144.246
```

```bash
ssh -i ~/.ssh/questbook_vps_ed25519 -p 2222 \
  -N -L 4000:127.0.0.1:4000 debian@151.80.144.246
```

Le front local parle alors à `http://localhost:4000`.

`ADMIN_HOST` vaut pourtant `0.0.0.0`, et ce n'est pas une contradiction :
écouter la boucle locale **du conteneur** le rendrait invisible à la
redirection de port de Docker elle-même. Ce qui ferme cette API est l'adresse
de publication, pas l'adresse d'écoute.

### Ce qu'elle n'a pas

- **Pas de CORS.** Le front local passe par le proxy de son serveur de dev, si
  bien que le navigateur ne parle qu'à sa propre origine. Il n'y a aucune
  origine à autoriser, et en autoriser une serait le premier trou dans une
  porte dont toute la défense est d'être fermée. Un test l'épingle.
- **Pas de parseur de corps JSON vide.** Celui de `app.ts` ménage Dio, qui
  estampille `application/json` sans corps ; `fetch` ne le fait pas.
- **Pas de `/v1`.** Cette API et son front partent du même dépôt, dans le même
  geste, et n'ont jamais à se contredire.

### Le conteneur n'applique pas les migrations

`docker-entrypoint.sh` lance `prisma migrate deploy` avant de démarrer, et deux
conteneurs qui l'exécutent au même démarrage se disputent le verrou de Prisma.
Le service `admin` court-circuite donc ce point d'entrée (`entrypoint: node`)
et attend que l'API soit saine, ce qui garantit que les migrations sont déjà
passées.

### La connexion

Le tunnel prouve qu'une machine a la clé du VPS. Il ne dit pas qui est devant
le clavier, et un portable qui change de mains emporte la clé avec lui. Le
backoffice a donc sa propre ouverture de session, sans aucun rapport avec celle
des joueurs.

| Méthode  | Route                  | Description                               |
| -------- | ---------------------- | ----------------------------------------- |
| `POST`   | `/admin/auth/session`  | `{ login, password, totp }` → jeton (201) |
| `DELETE` | `/admin/auth/session`  | Referme la session courante (204)         |
| `GET`    | `/admin/auth/me`       | Le compte connecté                        |

**Pas de Google ici.** Un joueur passe par un fournisseur tiers parce qu'une
table se partage et que chacun doit être reconnaissable des autres. Un
administrateur n'a personne à qui se présenter : faire dépendre l'accès au
backoffice d'un service extérieur n'apporterait rien et exposerait une surface
OAuth de plus.

`admin_users` n'a d'ailleurs **aucune relation vers `users`** : un
administrateur n'est pas un joueur avec un drapeau. Les deux populations n'ont
ni la même porte, ni la même façon de prouver qui elles sont, et les mélanger
ferait qu'une faille dans la connexion des joueurs deviendrait une faille dans
l'administration.

#### Deux primitives écrites à la main, et pourquoi

- **`scrypt` plutôt qu'argon2.** Argon2 est un module natif à compiler dans
  l'image Docker, et l'écart entre les deux est théorique pour une connexion
  limitée en débit, verrouillée après cinq échecs et joignable par un seul
  tunnel. `scrypt` est dans la bibliothèque standard. Les paramètres voyagent
  dans l'empreinte, donc les relever plus tard n'invalidera pas l'existant.
- **TOTP sur `node:crypto`.** Un HMAC, un compteur et un modulo. C'est le parti
  pris d'`apple-verifier.ts`, qui vérifie une signature RS256 à la main plutôt
  que de dépendre d'une bibliothèque JWT entière. Les **vecteurs de référence
  de la RFC 6238** sont dans la suite de tests : c'est ce qui rend le choix
  défendable.

#### Ce qui freine une attaque

- **Une seule réponse à tous les refus**, `401 Identifiants invalides`. Dire
  laquelle des deux moitiés est fausse diviserait par deux le travail de
  deviner l'autre, et dire que le login existe nommerait le compte à attaquer.
  Un login inconnu est même vérifié contre une empreinte leurre, pour qu'il
  coûte le même temps qu'un login connu.
- **Verrouillage** après cinq échecs consécutifs, quinze minutes.
- **Un budget de requêtes propre à la connexion**, dix par cinq minutes, bien
  en dessous de celui de l'application. Il couvre ce qu'aucun verrou par compte
  ne voit : un même mot de passe essayé sur beaucoup de logins.
- **Un code TOTP ne sert qu'une fois.** Il reste valable ses trente secondes,
  donc qui l'a lu par-dessus l'épaule pourrait le rejouer ; `last_totp_step`
  l'en empêche.

#### La session

Un **jeton opaque haché** en base, sur le modèle des `refresh_tokens` et des
jetons d'invitation, plutôt qu'un JWT. La raison est précise : un backoffice
doit pouvoir être déconnecté à distance, ce qu'un jeton que le serveur ne
relit jamais ne permet pas.

Trente minutes, **glissantes** : chaque requête repousse l'échéance, si bien
qu'un poste laissé seul se referme et qu'une soirée de modération ne se fait
pas interrompre au milieu d'un dossier.

#### Le journal d'audit

`admin_audit_log` enregistre ce que l'administration a fait. C'est le seul
composant du produit capable de lire les données de tout le monde et d'effacer
le compte de quelqu'un : la trace n'est pas une option.

`recordAudit` prend un client Prisma **ou une transaction ouverte**, et les
appelants écrivent leur ligne dans la transaction de l'action qu'elle
journalise — comme le font déjà les notifications. Un journal écrit après coup
manque précisément les cas où il servirait, ceux qui ont échoué en chemin.

`admin_id` est nullable : une tentative sur un login inconnu mérite sa ligne
autant qu'une réussite, et c'est même la plus intéressante des deux. Aucun
secret n'y entre, et un test lit toutes les lignes que la connexion peut
produire pour s'en assurer.

### La file des signalements

| Méthode | Route                        | Description                              |
| ------- | ---------------------------- | ---------------------------------------- |
| `GET`   | `/admin/reports`             | `?status=open\|resolved`, `limit`, `offset` |
| `GET`   | `/admin/reports/:id`         | Le dossier complet                       |
| `POST`  | `/admin/reports/:id/resolve` | `{ resolution, note? }`                  |

`POST /api/v1/reports` enregistrait un signalement et réveillait le support par
mail ; après quoi, plus rien. Savoir ce qui restait à examiner demandait un
`psql` sur le VPS, alors que les conditions d'utilisation annoncent un examen
**sous vingt-quatre heures**. C'est pour tenir cet engagement que cet écran
existe avant les statistiques et l'administration du contenu.

**Le plus ancien en tête.** La file se lit par son bout le plus urgent, celui
qui approche des vingt-quatre heures.

Le détail d'un dossier montre ce qui permet de décider, et rien de plus :
l'instantané et le motif, les deux comptes, et **les autres dossiers visant le
même compte**. Ce dernier point est le signal le plus utile du lot — deux
personnes différentes qui signalent la même personne disent quelque chose
qu'un dossier isolé ne dit pas.

Trancher est **idempotent sans réécrire la date** : un double clic ne déplace
pas le moment où le dossier a été tranché, exactement comme `POST /auth/terms`
ne déplace pas un consentement. Une ligne d'audit part dans la transaction.
Consulter la file, en revanche, n'est pas journalisé : c'est le geste ordinaire
du poste, et une ligne par rafraîchissement noierait celles qui comptent.

> `resolution` vaut `dismissed`, `warned`, `suspended` ou `deleted`. Les deux
> derniers **ne sanctionnent personne par eux-mêmes** : ils disent ce qui a été
> décidé, la sanction se posant plus bas. Les deux gestes restent séparés à
> dessein — un compte se suspend souvent pour un faisceau de dossiers, pas pour
> celui qu'on avait sous les yeux, et un dossier se classe parfois sans que
> personne ne soit sanctionné.

### Agir sur un compte

| Méthode  | Route                       | Description                            |
| -------- | --------------------------- | -------------------------------------- |
| `GET`    | `/admin/users/suspended`    | Les mesures encore actives             |
| `GET`    | `/admin/users/:id`          | Le compte, et ce qu'une fermeture détruirait |
| `POST`   | `/admin/users/:id/suspend`  | `{ reason, until? }`                   |
| `DELETE` | `/admin/users/:id/suspend`  | Lève la suspension                     |
| `DELETE` | `/admin/users/:id`          | `{ confirmEmail }` — ferme le compte   |

**Suspendre plutôt que supprimer.** Fermer est irréversible et emporte les
tables que le compte animait : la bonne réponse à quelqu'un qui n'a rien à
faire là, une réponse disproportionnée à un titre de séance grossier.

`suspended_until` nul veut dire indéfiniment. Une suspension datée **expire
d'elle-même**, relue à chaque contrôle plutôt que balayée par une tâche de
fond : il n'y a pas d'ordonnanceur ici, et une colonne que personne ne nettoie
garderait quelqu'un dehors pour toujours.

C'est ce qui rend `GET /admin/users/suspended` moins anodin qu'il n'y paraît :
**filtrer sur la seule présence de `suspended_at` listerait des comptes déjà
revenus**, puisque rien ne l'efface à l'échéance. La route applique donc le
même `isSuspended` que les quatre contrôles.

L'ordre y porte le sens : **les indéfinies d'abord**, seules à attendre une
décision humaine — sans écran qui les rappelle, elles deviennent une exclusion
définitive par oubli plutôt que par décision — puis les datées, par échéance la
plus proche.

Cette route existe parce que la file des signalements ne répond pas à la
question : une fois le dossier classé, le compte suspendu sort de l'écran.

#### Elle mord à quatre endroits

C'est le cœur de la chose. Une mesure qui ne mord qu'à trois des quatre est une
mesure qu'on contourne, et le contournement n'est jamais celui qu'on
surveillait.

| Où | Pourquoi |
| --- | --- |
| `app.authenticate` | Le jeton d'accès déjà en main vaut encore un quart d'heure. |
| `POST /auth/google` | Se reconnecter ne doit pas contourner la mesure. |
| `POST /auth/apple` | Idem, par l'autre porte. |
| `POST /auth/refresh` | Pour le jeton émis entre-temps, que la révocation rate. |

Suspendre révoque au passage les jetons de rafraîchissement du compte, dans la
même transaction. Ce n'est pas suffisant pour autant : un jeton émis juste
avant survivrait, d'où le quatrième contrôle.

Le prix est **une lecture par clé primaire à chaque requête authentifiée**, là
où la garde ne touchait pas la base. C'est ce que coûte une suspension qui
prend effet tout de suite plutôt que dans quinze minutes.

#### Ce que le joueur reçoit

`403` avec un code nommé, là où le reste de l'API préfère la discrétion :

```json
{
  "error": {
    "code": "ACCOUNT_SUSPENDED",
    "message": "Ce compte est suspendu.",
    "details": { "reason": "…", "until": "2026-09-26T20:39:16.708Z" }
  }
}
```

Un `404` n'aurait aucun sens ici : on parle à la personne même que la mesure
vise, et la laisser croire à une panne ne ferait que la faire revenir dix fois.
Le motif voyage parce qu'elle est censée le lire — c'est aussi pourquoi il est
exigé : une sanction sans motif est une sanction qu'on ne peut pas contester.

#### Fermer un compte

C'est le seul endroit du produit où un tiers détruit les données de quelqu'un
d'autre, et la cascade emporte les tables qu'il animait — `GameTable.ownerId`
est en cascade, une table sans MJ étant une salle morte.

L'appelant doit donc **recopier l'adresse du compte**, que `GET
/admin/users/:id` vient de lui montrer avec le nombre de tables en jeu. C'est
ce qui sépare une décision d'un faux mouvement de souris.

La ligne d'audit est écrite **avant** la suppression et hors de sa transaction :
`admin_audit_log` ne pointe pas vers `users`, mais une trace qui disparaîtrait
avec ce qu'elle trace ne vaudrait rien.

### Le catalogue des scénarios

| Méthode | Route                  | Description                                  |
| ------- | ---------------------- | -------------------------------------------- |
| `GET`   | `/admin/scenarios`     | Le catalogue, et ce que chaque aventure pèse |
| `GET`   | `/admin/scenarios/:id` | Le document entier, PNJ et indices compris   |
| `POST`  | `/admin/scenarios`     | Écrit une aventure (201)                     |
| `PATCH` | `/admin/scenarios/:id` | Corrige tout ou partie de celle-ci           |

Le catalogue n'avait jusqu'ici aucun autre moyen d'exister qu'un `INSERT`
écrit à la main dans une migration : les trois aventures livrées sont arrivées
ainsi, et leurs PNJ et leurs indices aussi. Écrire une aventure demandait donc
un déploiement, et corriger une faute de frappe également.

C'est le seul écran du backoffice qui ne touche pas aux comptes : il écrit du
produit. Il y vit quand même, parce qu'il réclame exactement la même porte —
un mot de passe, un code, et aucune route vers Internet.

**Une modification ne redescend pas.** L'app garde le scénario tel qu'elle l'a
téléchargé, et rien ici ne va la réveiller : seul un compte qui télécharge
après coup verra la nouvelle version. C'est voulu — une séance commencée ne
doit pas voir son déroulé changer sous les yeux du meneur — et cela veut dire
qu'une faute corrigée ce soir reste chez ceux qui possèdent déjà l'aventure.
L'écran le dit là où on corrige, plutôt que de laisser croire à une diffusion.

#### Les listes font autorité, et les identifiants tiennent

`npcs` et `clues` sont facultatifs dans un `PATCH` ; **envoyés, ils
remplacent**. Ce qui n'y figure plus est supprimé, faute de quoi retirer un
PNJ n'aurait aucun geste.

Chaque élément porte son `id` quand il existe déjà, et rien quand le
formulaire vient de l'ajouter. C'est ce qui permet de réécrire une aventure
entière sans redistribuer d'identifiants : ceux des indices sont cités par
`scenario_clue_access`, donc par ce que des joueurs ont déjà reçu en séance.
Un `id` venu d'une autre aventure est refusé — sans quoi il y déplacerait son
PNJ en silence.

> Supprimer un indice emporte ses `scenario_clue_access` par cascade, c'est-à-dire
> la trace de ce qui a été distribué. Le détail donne donc `sharedWith` par
> indice, l'écran l'affiche avant qu'on clique, et la ligne d'audit compte ce
> que la suppression a révoqué : le chiffre serait introuvable après coup.

L'ordre d'affichage n'est pas demandé, c'est celui du tableau reçu.
`grantOnSignup` offre l'aventure à tout le monde : `grantStarterScenarios`
tourne à chaque connexion, donc chaque compte la reçoit à la suivante.

Les actions journalisées sont `scenario.create` et `scenario.update`.

### Créer un compte

Il n'y a pas de route d'inscription : un backoffice qui en ouvrirait une
donnerait à Internet le formulaire qu'on cherche justement à lui cacher.

```bash
npm run admin:create robin              # nouveau compte
npm run admin:create robin -- --reset   # même login, tout neuf
```

Le script demande le mot de passe deux fois, puis dessine un **QR code** à
scanner dans une application d'authentification, avec la clé en base32 juste
en dessous au cas où le QR passe mal — une fenêtre trop étroite suffit à le
casser. **Rien de tout cela ne se réaffiche** : la base ne garde que de quoi
vérifier un code, et le secret perdu se remplace par un `--reset`.

#### Sur le VPS

Le même outil, mais **compilé**, parce que l'image de production n'a ni `tsx`
ni les sources TypeScript :

```bash
ssh -p 2222 debian@<vps> 'cd /opt/questbook && docker compose exec admin \
  node dist/admin/cli/create-admin.js robin'
```

C'est la raison pour laquelle ces deux outils vivent dans `src/admin/cli/` et
non dans `scripts/` : ce dernier n'est pas copié dans l'image, et un
backoffice déployé sans moyen d'y créer le premier compte serait un backoffice
auquel personne ne peut se connecter — sans porte de secours, puisqu'il n'y a
pas d'inscription.

Les comptes de la base de dev et ceux du VPS n'ont évidemment rien à voir.

### Le front

`admin-web/`, un projet Vite/React **qui n'est deployé nulle part**. Il tourne
sur le poste de qui modère, le temps d'une session, et c'est tout ce qu'on lui
demande : pas d'hébergement, pas de domaine, pas de build à distribuer, et une
surface d'attaque qui se réduit à un onglet.

```bash
cd admin-web && npm install   # une fois
npm run dev                   # http://localhost:5174
```

Il lui faut l'API d'administration à l'autre bout, **au choix** :

```bash
npm run dev:admin                              # la base de dev, sans risque
../questbook-ia/scripts/tunnel-admin.sh        # le VPS, par le tunnel
```

> ⚠️ Le proxy pointe vers `127.0.0.1:4000` **dans les deux cas**, et rien à
> l'écran ne dit lequel répond. Se tromper veut dire suspendre un vrai compte
> en croyant jouer avec des données de dev. C'est pour cela que le script de
> tunnel refuse de s'ouvrir quand le port est déjà pris, plutôt que de laisser
> les deux se disputer l'adresse.

Le jeton de session vit dans `sessionStorage`, et pas plus loin. En mémoire
seulement aurait redemandé un code à chaque rechargement, ce qui pousse à
garder l'onglet ouvert — l'inverse du but ; `localStorage` survivrait au
navigateur, ce qui est trop.

Le risque habituel de ce choix, le vol par script injecté, est écarté ici :
aucune origine tierce ne parle à ce front, et **React échappe tout ce qu'il
interpole**. Cela compte plus qu'ailleurs — c'est le seul écran du produit qui
affiche, par construction, du texte écrit par quelqu'un qui cherchait à nuire.
Jamais de `dangerouslySetInnerHTML` sur un instantané, jamais de `href`
construit depuis un de ses champs.

### En local

```bash
npm run dev:admin            # http://localhost:4000
curl http://localhost:4000/health
```

Le compte se cree a la main, il n'y a pas de route d'inscription :

```bash
npm run admin:create robin    # ou -- --reset, si le secret est perdu
```

Le script demande un mot de passe — **sans rien afficher pendant la frappe**,
pas meme des asterisques — puis imprime une URI `otpauth://` a donner une fois
a une application d'authentification. Elle ne sera pas reaffichee.

Pour essayer un ecran sans sortir son telephone a chaque rechargement :

```bash
npm run admin:totp robin              # le code courant, en clair
```

Il refuse de tourner sur une base qui n'est pas locale : il divulgue un second
facteur, et `DATABASE_URL` peut pointer ailleurs qu'on ne le croit.

---

## Endpoints

Préfixe : `/api/v1`. Toutes les routes exigent l'en-tête
`Authorization: Bearer <accessToken>`, à la seule exception de la page web
d'acceptation d'invitation, servie hors préfixe (voir plus bas).

### Authentification

| Méthode | Route            | Description                                     |
| ------- | ---------------- | ----------------------------------------------- |
| `POST`  | `/auth/google`   | Inscription/connexion depuis un ID token Google |
| `POST`  | `/auth/apple`    | Idem depuis un jeton d'identite Apple           |
| `POST`  | `/auth/refresh`  | Rotation du couple de jetons                    |
| `POST`  | `/auth/logout`   | Révoque le refresh token (204)                  |
| `GET`   | `/auth/me`       | Profil de l'utilisateur connecté                |
| `PATCH` | `/auth/me`       | Change le pseudo (`displayName`, 1 à 60 signes) |
| `POST`  | `/auth/terms`    | Accepte les conditions d'utilisation            |
| `DELETE`| `/auth/me`       | Efface le compte et tout ce qui en dépend (204) |

`termsAcceptedAt` accompagne le profil **partout** : connexion,
rafraîchissement et `/auth/me`. C'est là-dessus que l'app barre son premier
écran, et le lui faire demander à part ajouterait un appel là où il n'en faut
aucun. Il est nul pour un compte neuf comme pour ceux qui existaient avant la
publication des conditions — personne ne les a acceptées, et supposer le
contraire serait signer à leur place.

`POST /auth/terms` est sans corps : il n'y a rien à nuancer dans un
consentement, et la version acceptée se déduit de la date, seule publiée ce
jour-là. Il est idempotent **sans réécrire la date** : une app relancée deux
fois sur un réseau capricieux ne doit pas déplacer le moment où le compte a
dit oui.

### Personnages

| Méthode  | Route                | Description                                          |
| -------- | -------------------- | ---------------------------------------------------- |
| `GET`    | `/characters`        | Liste ; `?since=<ISO>` pour un pull incrémental       |
| `POST`   | `/characters`        | Création (201)                                        |
| `GET`    | `/characters/:id`    | Détail complet                                        |
| `PUT`    | `/characters/:id`    | Push de synchronisation, agrégat complet, LWW         |
| `PATCH`  | `/characters/:id`    | Modification des champs simples (nom, niveau…)        |
| `DELETE` | `/characters/:id`    | Suppression logique (tombstone, 204)                  |

### Inventaire, stats et ressources

| Méthode  | Route                                     | Description                    |
| -------- | ----------------------------------------- | ------------------------------ |
| `GET`    | `/characters/:id/inventory`               | Liste des objets               |
| `POST`   | `/characters/:id/inventory`               | Ajout d'un objet (201)         |
| `PATCH`  | `/characters/:id/inventory/:itemId`       | Nom, quantité, poids           |
| `DELETE` | `/characters/:id/inventory/:itemId`       | Retrait (204)                  |
| `PATCH`  | `/characters/:id/stats/:kind/:key`        | Valeur d'une stat              |
| `PATCH`  | `/characters/:id/resources/:key`          | `current` / `max`, borné [0,max] |

Les stats et ressources sont adressées par leur **clé métier** (`bibliotheque`,
`pv`) et non par un identifiant de ligne, exactement comme le fait déjà
`CharacterRepository` côté Flutter.

### Tables et invitations

| Méthode  | Route                                    | Description                                  |
| -------- | ---------------------------------------- | -------------------------------------------- |
| `GET`    | `/tables`                                | Tables dont on est membre                    |
| `POST`   | `/tables`                                | Création ; le créateur devient MJ (201)      |
| `GET`    | `/tables/:id`                            | Détail : membres, invitations, prochaine date |
| `PATCH`  | `/tables/:id`                            | Titre (MJ)                                   |
| `DELETE` | `/tables/:id`                            | Dissolution (MJ, 204)                        |
| `DELETE` | `/tables/:id/members/me`                 | Quitter la table (204)                       |
| `DELETE` | `/tables/:id/members/:userId`            | Exclure un joueur (MJ, 204)                  |
| `PUT`    | `/tables/:id/game-master`                | Confier la table à un joueur (MJ)            |
| `POST`   | `/tables/:id/invitations`                | Inviter par e-mail (MJ, 201)                 |
| `DELETE` | `/tables/:id/invitations/:invitationId`  | Révoquer une invitation (MJ, 204)            |
| `GET`    | `/invitations`                           | Invitations reçues, en attente               |
| `POST`   | `/invitations/:id/accept`                | Accepter depuis l'app                        |
| `POST`   | `/invitations/:id/decline`               | Décliner (204)                               |

`universeLabel` reste accepté par `POST`/`PATCH /tables` et renvoyé tel quel :
l'app ne l'envoie ni ne l'affiche plus depuis qu'elle est dédiée à l'Appel de
Cthulhu, mais les tables créées avant gardent le leur. Aucun traitement ne le
lit ; la colonne attend qu'on décide un jour de revenir au multi-univers ou de
la supprimer.

### Sessions et participation

| Méthode  | Route                                          | Description                                       |
| -------- | ---------------------------------------------- | ------------------------------------------------- |
| `GET`    | `/tables/:id/sessions`                         | Sessions de la table                              |
| `POST`   | `/tables/:id/sessions`                         | Proposer une session (MJ, 201)                    |
| `GET`    | `/sessions/:id`                                | Détail et réponses de chacun                      |
| `PATCH`  | `/sessions/:id`                                | Titre, description, date, lieu, scénario (MJ) |
| `DELETE` | `/sessions/:id`                                | Annulation — la session reste visible             |
| `PUT`    | `/sessions/:id/attendance`                     | `{ "status", "characterId"? }` — venir exige un personnage |
| `PUT`    | `/sessions/:id/attendance/character`           | En changer, jusqu'à la fin de la séance           |
| `GET`    | `/sessions/:id/attendances/:userId/character`  | Fiche d'un participant, lisible par la table      |
| `GET`    | `/sessions/:id/npcs`                           | Personnages non-joueurs (MJ seul)                 |
| `POST`   | `/sessions/:id/npcs`                           | En ajouter un (MJ, 201)                           |
| `PATCH`  | `/sessions/:id/npcs/:npcId`                    | Nom, description (MJ)                             |
| `DELETE` | `/sessions/:id/npcs/:npcId`                    | Le retirer (MJ, 204)                              |
| `GET`    | `/sessions/:id/clues`                          | Les indices et leurs destinataires (MJ seul)      |
| `POST`   | `/sessions/:id/clues`                          | En composer un, en markdown (MJ, 201)             |
| `PATCH`  | `/sessions/:id/clues/:clueId`                  | Titre, contenu (MJ)                               |
| `DELETE` | `/sessions/:id/clues/:clueId`                  | Le retirer (MJ, 204)                              |
| `PUT`    | `/sessions/:id/clues/:clueId/access`           | `{ "userIds" }` — remplace la liste (MJ)          |
| `GET`    | `/sessions/:id/clues/mine`                     | Les indices qu'on m'a ouverts, et eux seuls       |
| `GET`    | `/sessions/:id/board`                          | Le plateau, lisible par toute la table            |
| `PUT`    | `/sessions/:id/board`                          | Le remplacer entier (MJ)                          |
| `GET`    | `/sessions/:id/board/live`                     | WebSocket : le plateau, puis chaque poussée       |

Le MJ n'est pas un participant : il anime la séance, ne répond pas et n'est pas
compté parmi les joueurs attendus. `PUT /sessions/:id/attendance` lui répond 403.

Le champ `nextSessionAt` d'une table ne désigne **que** des séances à venir, et
vaut `null` s'il n'y en a aucune. Rien ne fait changer de statut une session une
fois qu'elle a eu lieu : sans ce filtre, la plus ancienne séance `scheduled`
resterait éternellement en tête et masquerait celle que les joueurs attendent.

#### Les indices, et le premier destinataire du schéma

Un indice est l'inverse d'un PNJ : préparé de la même façon, mais destiné à
passer de l'autre côté de l'écran — un par un, et seulement à ceux que le MJ
désigne. Comme les PNJ, il appartient à la séance et non à la table, et n'a pas
de colonne de propriétaire : une séance n'a qu'un MJ.

C'est **la première donnée de Questbook à porter un destinataire**. Le plateau
est tout-ou-rien pour la table entière, les PNJ tout-ou-rien pour le MJ. D'où
`session_clue_access`, une ligne par couple `(indice, joueur)`, où **l'absence
de ligne est le défaut** : un indice n'est à personne tant que le MJ n'a rien
fait.

`PUT .../access` remplace la liste plutôt que d'y ajouter, parce que c'est le
geste de l'écran : le MJ coche des noms et valide. Reprendre un indice est donc
le même appel avec un nom de moins, et un tableau vide est la façon légitime de
le reprendre à tout le monde — pas une erreur à refuser.

`GET .../clues/mine` est la seule route ouverte à un joueur, et elle ne laisse
**rien** filtrer du reste : ni compte, ni identifiant, ni trou dans un ordre. Ce
que le MJ garde ne doit pas se deviner. Son DTO n'est d'ailleurs pas celui du MJ
amputé de `sharedWith` : le champ n'existe pas de ce côté, sinon quelqu'un
finira par l'envoyer vide au lieu de l'omettre.

Attention à un piège que les cascades ne couvrent pas : **une permission pend au
compte, pas à l'appartenance à la table**. Retirer un joueur ne la supprimerait
donc pas, et son retour lui rendrait en silence tout ce qui lui avait été
ouvert. `TableService.dropMembership` s'en charge, pour le départ volontaire
comme pour le retrait par le MJ.

Pas de temps réel ici : un joueur découvre ses indices en ouvrant son volet. Le
canal WebSocket reste dédié au plateau.

#### Ce que le scénario apporte à la séance

Une séance qui déclare un scénario joue **deux piles à la fois** : ce que le
catalogue livre, et ce que le MJ a écrit. `GET /sessions/:id/npcs` et
`GET /sessions/:id/clues` renvoient les deux, celles du scénario d'abord, et
chaque élément porte son `origin` — `scenario` ou `gameMaster`.

**Rien n'est copié.** La séance lit le catalogue à chaque appel, si bien qu'une
correction apportée à une aventure se voit le soir où on la joue. En échange,
tout ce qui distingue les deux piles tient en une règle : `PATCH` et `DELETE`
sur un élément du scénario répondent **400**, pas 404. Le MJ l'a sous les yeux ;
lui dire « introuvable » l'enverrait chercher un bug là où il n'y a qu'une
règle.

Le partage, lui, fonctionne à l'identique sur les deux — c'est la raison d'être
d'un indice livré avec l'aventure. Il lui fallait juste sa propre table :
`scenario_clue_access` porte **la séance dans sa clé**, là où
`session_clue_access` n'en a pas besoin. Le même carnet de la crique se
transmet soir après soir, à d'autres tables, à d'autres gens, et rien de tout
cela ne doit se suivre d'une séance à l'autre.

Retirer ou changer le scénario d'une séance reprend ce qu'il avait distribué
(`SessionService.patch` efface les lignes d'accès). Le MJ n'a jamais pu modifier
ces indices, donc rien de son travail ne disparaît — alors qu'une permission
oubliée laisserait un joueur relire le document d'une aventure qui ne se joue
plus.

#### Le plateau, et pourquoi il est monté ici

Le plateau vivait sur l'appareil seul. Il est remonté le jour où un joueur a dû
le regarder bouger : une table est partagée, donc ce que tout le monde regarde
ne peut pas rester privé à une tablette.

**L'appareil du MJ reste la vérité.** Il écrit en local d'abord et pousse quand
il peut — une soirée dans une cave sans couverture doit continuer de marcher, et
un plateau qui demanderait le réseau pour déplacer un pion serait inutile
précisément là où on l'utilise. `session_boards` est donc une **copie que les
joueurs lisent**, et la dernière poussée gagne sans fusion : un seul compte y
écrit jamais.

Trois conséquences :

- **Le plateau arrive entier, jamais en différence.** L'appareil détient l'état
  complet, et envoyer un delta laisserait les deux s'écarter au premier message
  perdu. `revision` monte de un à chaque poussée, ce qui permet à un écoutant
  d'écarter un message arrivé en retard.
- **Les pions restent opaques.** `tokens` est la même chaîne JSON que l'app
  garde en local ; le serveur vérifie qu'il s'agit d'un tableau et sa taille,
  rien de plus. Connaître la forme d'un pion est le travail du client, et un
  serveur qui la validait devrait être mis à jour avant qu'un nouveau type de
  pion puisse être posé.
- **C'est l'image inverse des PNJ.** Là, le MJ seul lit ; ici, toute la table
  lit et le MJ seul écrit. Un plateau est fait pour être vu, une créature
  préparée est faite pour ne pas l'être.

Un plateau jamais poussé répond **un plateau vide, pas un 404** : la session
existe, et un joueur peut l'ouvrir avant que le MJ ait posé quoi que ce soit.

##### Le canal temps réel

`GET /sessions/:id/board/live` est une **WebSocket** (`@fastify/websocket`),
authentifiée par le même en-tête `Authorization` que le reste — la poignée de
main est une requête HTTP comme une autre. Elle envoie d'abord le plateau
entier, puis un message `{ "type": "board", "board": … }` à chaque poussée du
MJ. Sans ce premier message, le client devrait aussi appeler `GET` et verrait un
plateau vide jusqu'au geste suivant.

Le choix d'une WebSocket plutôt que d'une interrogation périodique tient au
ressenti : un pion qu'on voit bouger trois secondes après le MJ donne
l'impression de regarder un enregistrement, et une table qui joue ne supporte
pas ce décalage.

**Qui écoute quoi est gardé en mémoire** (`BoardLiveRegistry`), et non en base :
ce n'est pas un fait sur la soirée, c'est la liste des sockets que ce processus
détient. La perdre à un redémarrage est correct — les sockets meurent avec le
processus, et chaque client se reconnecte et redemande le plateau.

> **Cela ne marche que parce que l'API tourne en un seul processus.** Le jour
> où elle tournera en deux derrière Caddy, un MJ servi par l'une pousserait
> vers des écoutants que l'autre détient, et rien n'arriverait. C'est le moment
> où il faudra un courtier entre les deux, et la raison pour laquelle cette
> classe est assez petite pour être remplacée.

Un socket qui refuse un message est retiré plutôt que réessayé : le plateau est
un état, pas un flux d'événements, donc la poussée suivante porte tout ce que
la manquée portait.

#### Les deux instants qui bornent une séance

Une séance ne s'éteint pas à l'heure dite : on joue, et la partie déborde
toujours. Deux instants la bornent donc, calculés dans `session.window.ts` et
**envoyés dans le DTO** — le client n'a pas à reconstituer la règle, et deux
implémentations ne peuvent pas diverger.

| Champ | Ce qu'il vaut | Ce qu'il ferme |
| --- | --- | --- |
| `closesAt` | Début + 24 h | La séance bascule dans le passé : elle cesse d'être la `nextSessionAt` de sa table, et il n'y a plus rien à y animer. |
| `answersCloseAt` | Le plus tard entre le début et création + 1 h | Plus personne ne s'inscrit : le MJ a compté ses joueurs. |

Les 24 heures existent pour qu'une session **reste consultable et modifiable
en pleine partie** : la perdre à 20 h 01 parce qu'elle commençait à 20 h serait
absurde.

L'heure après la création sert le cas inverse, celui de la partie improvisée :
proposée à 18 h pour 18 h 30, la séance laisserait sinon trente minutes pour
répondre, moins le temps de voir passer la notification. Les inscriptions y
restent ouvertes jusqu'à 19 h. Proposée à 18 h pour 20 h, elles ferment bien à
20 h — le délai ne raccourcit jamais rien, il ne fait qu'éviter une fenêtre
trop courte.

Passé `answersCloseAt`, `PUT /sessions/:id/attendance` répond 409. Le MJ, lui,
continue de corriger sa séance : déplacer le lieu à mi-partie est précisément
ce que les 24 heures autorisent.

**`PUT /sessions/:id/attendance/character` suit `closesAt`, pas
`answersCloseAt`** : qui vient et avec qui ne ferment pas au même instant. Le
MJ a compté ses joueurs et ne veut plus d'arrivants, mais qui joue quoi bouge
encore une fois la table assise — un investigateur meurt, un autre le
remplace. Fermer les deux ensemble enfermait par ailleurs un joueur ayant
confirmé sans dire avec qui.

#### Venir, c'est venir avec quelqu'un

`status: 'yes'` **exige un personnage** : celui que la requête nomme, ou celui
que l'inscription portait déjà — revenir sur un « non » ne le redemande donc
pas. Sans l'un ni l'autre, 409 : « Dis avec quel investigateur tu viens. »
Une chaise sans fiche ne sert ni le MJ, qui ne sait pas qui il a en face, ni
le joueur, à qui l'app refuserait de participer à la séance.

Le corollaire est que **`characterId: null` est refusé sur une inscription
`yes`** : on ne se décommande pas par la bande, il y a `status: 'no'` pour
cela. Se décommander, lui, ne demande personne.

La règle vit sur le serveur et non dans la seule fenêtre du client : une
fenêtre qu'on referme ne garantit rien, et l'app demande d'ailleurs
l'investigateur *avant* d'appeler — d'où le `characterId` optionnel de
`PUT /sessions/:id/attendance`, qui rend la confirmation atomique.

Les deux gestes notifient le MJ séparément (`attendance_changed`,
`attendance_character_changed`), parce qu'ils lui apprennent deux choses
différentes ; une confirmation nomme l'investigateur dans son corps, puisque
les deux informations arrivent ensemble.

#### Les personnages non-joueurs

Tout ce qui est à la table sans être un joueur : créature, indicateur, esprit.
Un nom, une description libre, et rien d'autre — ce ne sont pas des fiches de
personnage, et ils n'ont ni caractéristiques ni propriétaire.

Ils appartiennent à la **session**, pas à la table : ce qu'on prépare pour une
veillée n'est pas ce qu'on prépare pour la suivante. Une session supprimée les
emporte, par cascade.

**Toutes ces routes sont réservées au MJ, lectures comprises.** C'est le fond
de la fonctionnalité : ce que le MJ a écrit est exactement ce que les joueurs
ne doivent pas savoir. Un joueur de la session reçoit 403, un inconnu 404 comme
partout ailleurs, et `GET /sessions/:id` ne les mentionne pas — il n'y a donc
pas de vue joueur à concevoir, ni à oublier de protéger.

Inscrire un personnage à une session l'ouvre en lecture aux autres membres de la
table, et à eux seuls. C'est la seule brèche dans l'isolement par compte des
personnages, et elle passe par la route ci-dessus : `/characters/:id` reste
strictement privé à son propriétaire.

Une session peut porter un `scenarioId` facultatif. Seul un scénario **possédé**
par le MJ peut y être accroché ; les autres membres voient le titre, pas le
document.

### Scénarios

| Méthode | Route              | Description                                              |
| ------- | ------------------ | -------------------------------------------------------- |
| `GET`   | `/scenarios`       | Résumés des scénarios possédés (titre, description, jauge) |
| `GET`   | `/scenarios/:id`   | Document complet, PNJ et indices compris, si possédé ; sinon 404 |

Personne ne crée de scénario par l'API : le catalogue est écrit en base
(migration / admin). Les scénarios marqués `grant_on_signup` sont donnés à
chaque compte à la connexion, pour que la liste ne soit pas vide ; les autres
s'achètent à la boutique. Un id inconnu ou non possédé répond **404**, pas
403 : le catalogue n'est pas public.

Le document complet porte tout ce dont une soirée a besoin, PNJ et indices
compris : l'app le stocke entier pour le lire hors ligne, et un second appel
pour la distribution serait une seconde occasion de manquer à l'appel. Les
**annexes** ont disparu au passage — elles étaient déjà des indices sans le
nom, tout le catalogue n'en contenant que de type `clue` et `handout`, et
`scenario_annexes` est devenue `scenario_clues`.

### Boutique

| Méthode | Route                      | Description                                        |
| ------- | -------------------------- | -------------------------------------------------- |
| `GET`   | `/shop/items`              | Tout le catalogue, chaque article portant `owned`  |
| `GET`   | `/shop/items/:id`          | Détail d'un article, `scenario_id` compris         |
| `POST`  | `/shop/items/:id/purchase` | Accorde l'article et le renvoie possédé            |

Trois partis pris valent d'être connus.

**La liste montre tout, possédé ou non** — l'inverse des scénarios, dont on ne
voit que ce qu'on détient. Une boutique qui cacherait ce qu'on n'a pas acheté
n'aurait rien à vendre. C'est `owned` qui fait disparaître le bouton d'achat,
d'où sa présence dès le résumé.

**La description voyage dès le résumé**, ce qui n'a pas toujours été le cas :
elle était réservée au détail, jusqu'à ce que l'app affiche les scénarios
pleine largeur avec quelques lignes de ce dont ils parlent. Un scénario dont
on ne peut rien lire est un scénario que personne n'ouvre. Le détail garde ce
qu'il avait en plus, `scenario_id`.

**L'achat est idempotent**, plutôt que 409 sur un article déjà détenu : un
double appui ne doit pas faire surgir une erreur, et le jour où de l'argent
changera de main, c'est exactement la propriété qu'on voudra.

**Le serveur ne décrit pas à quoi ressemble un pion.** Son rendu appartient à
l'app, comme le montre déjà `board_catalog.dart` ; un article de type `asset`
n'en porte que la clé. Même chose pour `image_key`, qui nomme une image
embarquée dans l'app et non une URL : rien ici n'héberge de fichier.

Acheter un article de type `scenario` écrit une ligne dans
`scenario_ownerships` avec `source: 'purchase'` — la lecture d'un scénario
reste gardée par cette table, si bien que rien en aval n'a à connaître
l'existence de la boutique. Le type `pack` n'a pas encore de contenu
modélisé et son achat est refusé. Un article au prix non nul l'est aussi, tant
qu'aucun paiement n'existe : sans ce garde-fou, il serait donné.

**Deux scénarios sont en rayon**, semés par
`20260921120000_shop_scenarios` : « Le Dernier Train de Nuit » et
« L'Herbier de Madame Sauvel ». Leur `grant_on_signup` est faux, à la
différence du Phare de Kerloc'h — les donner à l'inscription reviendrait à
n'avoir rien à vendre. Leur prix est nul comme tout le reste du rayon, faute
de paiement ; c'est ce qui les rend achetables aujourd'hui.

### Notifications et appareils

| Méthode  | Route                       | Description                                |
| -------- | --------------------------- | ------------------------------------------ |
| `GET`    | `/notifications`            | Historique + `unreadCount`                 |
| `POST`   | `/notifications/read`       | Marquer une liste d'identifiants lue (204) |
| `POST`   | `/notifications/read-all`   | Tout marquer lu (204)                      |
| `PUT`    | `/devices`                  | Enregistrer un jeton FCM (204)             |
| `DELETE` | `/devices/:token`           | Retirer un jeton, à la déconnexion (204)   |

### Signalements

| Méthode | Route      | Description                        |
| ------- | ---------- | ---------------------------------- |
| `POST`  | `/reports` | Signaler un contenu choquant (201) |

Le corps ne dit que **ce qui est visé et ce qu'on lui reproche** :
`{ contentType, contentId, reason }`, où `contentType` vaut `user`, `table`,
`session` ou `investigator`. Ni l'auteur du contenu ni sa copie ne viennent de
l'appelant : le serveur relit la cible lui-même, vérifie que l'appelant
pouvait la voir, et en prend l'instantané. Un signalement dont on laisserait
le client décrire la victime se forgerait en une requête.

**L'instantané est la raison d'être de la table.** Le contenu signalé se
réécrit dans la minute qui suit, et l'on examinerait sinon une version
repentie plutôt que celle qui a choqué. Il est stocké en JSON dans `snapshot`,
avec des libellés en français : ils finissent tels quels sous les yeux du
support.

Ce qu'on voit d'une cible décide de ce qu'on peut signaler : un joueur, s'il
partage une table ; une table ou une séance, si l'on en est membre ; un
investigateur, s'il s'est assis à une séance d'une table commune. Hors de là,
la réponse est `404` et non `403`, comme partout ici. Deux refus utiles s'y
ajoutent : `400` sur son propre contenu, `409` sur le même contenu deux fois —
signaler en boucle ne grossit pas le dossier, cela donne un levier de
harcèlement par le nombre.

Un mail part ensuite vers `REPORTS_EMAIL_TO`, sujet
`Questbook - nouveau signalement`. **Son échec ne fait pas échouer la
requête** : la ligne en base est ce qui fait foi, et l'on ne renvoie pas une
erreur à quelqu'un qui vient de subir quelque chose. Une adresse vide ne
réveille personne mais enregistre quand même, ce qui permet à un poste de
développement de tourner sans compte tiers.

### Blocages

| Méthode  | Route     | Description             |
| -------- | --------- | ----------------------- |
| `POST`   | `/blocks` | Bloquer quelqu'un (201) |

**Une seule route, et rien pour la défaire.** Ce n'est pas un oubli : ce que
le geste promet, c'est de ne plus croiser quelqu'un, et une promesse qu'on
retire d'un bouton n'en est pas une. Il n'y a donc ni liste à relire ni
déblocage, et un test épingle leur absence — ces routes ont existé, les
remettre par inadvertance se verrait.

Le blocage est **à sens unique** : il dit ce que *moi* je ne veux plus
croiser, et n'empêche pas l'autre de continuer sa vie ailleurs. Il est aussi
**idempotent** — bloquer deux fois est le même blocage, pas une erreur — mais
ses conséquences se rejouent à chaque appel, parce qu'une table rejointe
depuis doit se défaire comme les autres.

Car bloquer n'est pas qu'une promesse sur l'avenir, et c'est là tout l'intérêt
du geste : il défait aussi le présent, dans une transaction. Les invitations
en attente entre les deux comptes disparaissent **dans les deux sens** ;
celles adressées à d'autres n'y touchent pas. Puis chaque table commune se
règle selon mon rôle **à cette table-là** :

- j'y suis joueur → **je la quitte** ;
- j'en suis le MJ → **c'est l'autre qui en sort**, car partir laisserait une
  salle que plus personne ne peut animer.

Les deux cas coexistent dans un même appel, et la réponse les compte :
`{ tablesLeft, playersRemoved }`. L'app s'en sert pour dire ce qui vient de
se passer plutôt que de le laisser deviner — elle ne connaît qu'une table,
celle d'où part le geste.

Ensuite, `POST /tables/:id/invitations` refuse d'inviter qui m'a bloqué —
avec un `403` dont le message **ne dit pas pourquoi** : apprendre qu'on a été
bloqué est exactement ce que le geste évite, et une invitation sonderait
sinon tout un carnet d'adresses.

`GET /health` (hors préfixe) vérifie aussi la connexion PostgreSQL.

### Forme des erreurs

```json
{ "error": { "code": "CONFLICT", "message": "Stale write: the server holds a newer version",
             "details": { "character": { "...": "version serveur" } } } }
```

Codes : `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`CONFLICT`, `INTERNAL_ERROR`.

---

## Tables, sessions et notifications

Une table de jeu est un objet **partagé** : contrairement aux personnages, elle
n'est jamais stockée sur l'appareil et l'app la lit toujours en ligne. Cela
évite d'avoir à résoudre des conflits sur des données que plusieurs personnes
modifient en même temps.

### Invitations

```
MJ ──POST /tables/:id/invitations {email}──▶ API
                                             │  compte existant ?
                                             │  oui → invitation + notification
                                             │  non → invitation, pas de notif in-app
                                             ├──▶ Resend : lien /invitations/:token
Joueur inscrit ──GET/POST /invitations/:token─▶│  page HTML + acceptation
Joueur inconnu ──GET /invitations/:token─────▶│  page « installe l'app »
                                             └──▶ à la première connexion, l'invitation
                                                 apparaît dans l'onglet Tables
```

Garde-fous :

- **15 invitations par jour et par compte**, tous tables confondues, pour qu'un
  jeton volé ne spamme pas des boîtes quelconques.
- **8 joueurs par table** (le MJ n'est pas compté), invitations en attente
  comprises : une place réservée n'est plus libre.
- **Le lien n'accepte rien en `GET`.** Les clients mail préchargent les liens ;
  seul le `POST` du bouton engage un joueur déjà inscrit. Un jeton envoyé à une
  adresse sans compte n'enrolera personne tant que cette adresse n'a pas créé
  de compte. Le jeton suit le motif des refresh tokens : 48 octets aléatoires
  envoyés, hachage SHA-256 stocké, et ajouté à la liste `redact` du logger.

L'invitation reste par ailleurs visible et acceptable directement dans l'app
dès que le destinataire a un compte.

### Transmission du rôle de MJ

`PUT /tables/:id/game-master` **échange** les deux rôles au lieu d'en dupliquer
un : une table a exactement un MJ, et le sortant redevient joueur. `ownerId` est
mis à jour dans la même transaction, puisque c'est lui que lit le code des
notifications pour trouver le MJ.

Le nouveau MJ est retiré des participants des sessions **encore à venir**, parce
qu'il va désormais les animer. Les sessions passées ne sont pas retouchées : il y
avait joué, avec un personnage, et cela a eu lieu.

### Autorisations

Une garde d'appartenance renvoie **404** — et non 403 — pour une table dont on
n'est pas membre, comme pour les personnages : un appelant ne doit pas pouvoir
deviner quels identifiants existent. Une fois l'appartenance établie, un joueur
qui tente une action réservée au MJ reçoit un 403 : cacher la raison n'aurait
plus d'intérêt.

Une exception assumée à l'isolement par compte : la fiche d'un personnage inscrit
à une session est lisible par les autres membres de cette table. Elle passe par
`readSharedCharacter`, une fonction dont le nom annonce qu'elle ne vérifie
aucune propriété — l'autorisation est tenue par l'appartenance à la session, au
point d'appel. `requireOwned` reste inchangé et `/characters/:id` privé.

### Notifications

Huit événements : invitation reçue, invitation acceptée, session créée, session
modifiée (date ou lieu **seulement** — corriger une faute dans la description ne
réveille personne), session annulée, participation confirmée ou changée,
personnage renseigné ou changé, et transmission du rôle de MJ.

Pour chacun, la ligne `notifications` est écrite **dans la transaction** de la
modification qui la justifie : c'est la source de vérité, et l'historique
in-app est donc toujours juste. L'e-mail et le push partent ensuite au mieux,
après le commit, sans jamais faire échouer la requête. Un jeton d'appareil que
Firebase déclare mort est supprimé au passage.

`EmailSender` et `PushSender` sont deux interfaces étroites, calquées sur le
motif `GoogleVerifier`, injectables via `BuildAppOptions`. **Sans clé Resend ni
compte de service Firebase, les deux se contentent de journaliser ce qu'elles
auraient envoyé** : tout le parcours d'invitation reste utilisable en local
sans aucun compte tiers.

---

## Synchronisation

L'app reste **hors-ligne d'abord** : Drift demeure la source de vérité locale et
alimente les `Stream` de l'UI. L'API sert de miroir partagé entre appareils.

**Push** — `PUT /characters/:id` envoie l'agrégat complet avec l'`updatedAt` du
client. Le serveur applique un *last-write-wins* :

- horodatage plus récent → écriture acceptée, enfants remplacés en bloc ;
- horodatage plus ancien → `409 CONFLICT`, **avec la version serveur dans
  `error.details.character`** pour que le client l'adopte sans second aller-retour ;
- identifiant déjà détenu par un autre compte → `409` également.

**Pull** — `GET /characters?since=<curseur>` renvoie tout ce qui a bougé depuis,
**tombstones compris**, afin que les suppressions se propagent. La réponse
contient `syncedAt`, le curseur à réutiliser au prochain pull.

Toute écriture sur un enfant (objet d'inventaire, stat, ressource) fait avancer
l'horloge du personnage, sans quoi le changement resterait invisible aux autres
appareils.

---

## Développement local

```bash
npm install
cp .env.example .env          # puis remplir JWT_SECRET et GOOGLE_CLIENT_IDS

docker compose -f docker-compose.dev.yml up -d   # PostgreSQL sur localhost:5432
npx prisma migrate deploy                        # applique le schéma
npm run dev                                      # http://localhost:3000
```

`JWT_SECRET` doit faire au moins 32 caractères — `openssl rand -base64 48`.

L'app Flutter pointe alors sur l'API locale :

```bash
flutter run --dart-define=QUESTBOOK_API_URL=http://10.0.2.2:3000
```

> `10.0.2.2` est l'alias de `localhost` vu depuis l'émulateur Android. Sur un
> téléphone physique, utiliser l'IP LAN de la machine.

### S'asseoir à une table sans second compte Google

Vérifier ce qu'un joueur voit d'une séance demande deux comptes à la même
table : un MJ qui pousse le plateau, un joueur qui le regarde. Un émulateur
n'a qu'un compte Google connecté, et en brancher un second est long, manuel
et à refaire à chaque poste.

Le rôle ne vient pourtant pas de l'appareil, il vient de la table. Deux
scripts s'appuient là-dessus :

```bash
npx tsx scripts/seat-a-player.ts                  # les comptes de la base de dev
npx tsx scripts/seat-a-player.ts questbook.nextus # asseoir celui-ci comme joueur
npx tsx scripts/seat-a-player.ts questbook.nextus --mj # ou comme MJ
npx tsx scripts/push-as-gm.ts <sessionId> 4       # 4 pions, au nom du MJ
npx tsx scripts/push-as-gm.ts <sessionId> 4 grille # et la carte voulue
```

`seat-a-player` crée un compte de contrôle, une table où les deux sont
membres, et une séance **commencée depuis une heure** — de quoi voir
« Participer » sans attendre. `--mj` inverse les rôles : plusieurs gestes ne
se voient que depuis ce siège-là — retirer un joueur, ou le bloquer, qui le
sort de la table au lieu de m'en faire sortir. Les inscriptions restent ouvertes une heure
après la création de la séance, donc on peut encore répondre. Les
identifiants de carte se lisent dans `board_catalog.dart` de l'app :
`manoir`, `grille`.

Les deux signent un jeton avec le `JWT_SECRET` local : un compte de
contrôle n'a pas de compte Google derrière lui, et rien ne le connecterait
autrement. C'est aussi pourquoi ils n'ont rien à faire en production.

---

## Configuration Google Cloud

Dans le projet **`questbook-48540`** (déjà utilisé par Firebase App
Distribution), écran *API et services → Identifiants* :

1. **Client OAuth « Application Web »** — son identifiant sert de
   `serverClientId` côté Flutter et devient l'`aud` des ID tokens. C'est celui
   que l'API vérifie.
2. **Client OAuth « Android »** — nom de package `com.questbook.questbook`, avec
   les deux empreintes SHA-1 :

   | Keystore                       | SHA-1                                                     |
   | ------------------------------ | --------------------------------------------------------- |
   | Debug (`~/.android/debug.keystore`) | `50:BE:91:2B:5F:6D:10:2A:37:DB:4A:FC:26:F9:92:2F:80:48:04:67` |
   | Release (`.secrets/upload-keystore.jks`) | `C5:52:8A:C3:D1:30:14:8B:51:FF:96:1E:B9:52:07:4B:2A:6A:51:10` |

3. Renseigner ensuite `GOOGLE_CLIENT_IDS` dans `.env` avec **tous** les
   identifiants clients acceptés, séparés par des virgules.

> Sous Windows, `keytool` plante en locale française
> (`MissingFormatArgumentException`). Contournement utilisé ici : exporter le
> certificat avec `keytool -list -rfc` et calculer l'empreinte soi-même.

---

## Déploiement sur le VPS

Serveur OVH Debian 13, SSH sur le port **2222**, API publiée sur
**`https://questbook.nextuscorp.com`** (enregistrement A vers `151.80.144.246`).

Les trois scripts sont idempotents : les relancer ne casse rien.

```bash
# 1. Provisionnement (une seule fois) : Docker, firewall, /opt/questbook
ssh -p 2222 debian@151.80.144.246 'bash -s' < deploy/provision-vps.sh

# 2. Clone + génération du .env (secrets créés sur le VPS, jamais en transit)
ssh -p 2222 debian@151.80.144.246 \
  'API_DOMAIN=questbook.nextuscorp.com GOOGLE_CLIENT_IDS=<client-web>.apps.googleusercontent.com bash -s' \
  < deploy/bootstrap.sh

# 3. Build et démarrage (à relancer à chaque mise à jour de `main`)
ssh -p 2222 debian@151.80.144.246 'cd /opt/questbook && ./deploy/deploy.sh'
```

`bootstrap.sh` refuse d'écraser un `.env` existant : régénérer `JWT_SECRET`
déconnecterait tous les utilisateurs, et changer `POSTGRES_PASSWORD` après la
création du volume interdirait à l'API l'accès à sa propre base. Pour modifier
une valeur, éditer le fichier à la main puis relancer `deploy.sh`.

### E-mails d'invitation (Resend)

Sans `RESEND_API_KEY`, les invitations restent parfaitement fonctionnelles dans
l'app — seul l'e-mail est remplacé par une ligne de log. Pour les envoyer pour
de vrai :

1. Créer un compte sur [resend.com](https://resend.com) (palier gratuit :
   3 000 e-mails par mois, 100 par jour).
2. Y ajouter comme domaine d'envoi le **sous-domaine de l'API**,
   `questbook.nextuscorp.com`, et non le domaine racine. Deux raisons : le SPF
   de la racine se termine par `-all` pour la messagerie OVH, donc y ajouter un
   second expéditeur affaiblirait la protection d'une boîte qui n'a rien à voir
   avec l'app ; et l'adresse d'expédition se retrouve sur le même domaine que le
   lien d'acceptation contenu dans le message, cohérence que les filtres
   anti-spam apprécient.
3. Publier chez OVH les enregistrements DNS que Resend affiche (DKIM en `TXT`,
   `MX` de retour, et `TXT` SPF), puis lancer la vérification. Le `MX` cohabite
   sans problème avec l'enregistrement `A` de l'API sur le même nom.
4. Renseigner sur le VPS, dans `/opt/questbook/.env` :

   ```
   RESEND_API_KEY=re_xxxxxxxx
   EMAIL_FROM=Questbook <invitations@questbook.nextuscorp.com>
   REPORTS_EMAIL_TO=support@nextuscorp.com
   ```

`REPORTS_EMAIL_TO` est l'adresse que réveille un signalement. Elle est vide
par défaut, ce qui n'empêche rien d'être enregistré — mais en production,
laisser ce champ vide voudrait dire qu'un contenu signalé n'atteint personne,
alors qu'Apple attend qu'il disparaisse sous 24 h.

### Notifications push (Firebase)

Sans compte de service, l'historique in-app continue de fonctionner et seul le
push est ignoré. Pour l'activer :

1. Console Firebase du projet `questbook-48540` → *Paramètres du projet* →
   *Comptes de service* → **Générer une nouvelle clé privée** (JSON).
2. Recopier trois de ses champs dans `/opt/questbook/.env`, en **conservant les
   `\n` échappés** de la clé privée tels quels :

   ```
   FIREBASE_PROJECT_ID=questbook-48540
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@questbook-48540.iam.gserviceaccount.com
   FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n
   ```

3. `./deploy/deploy.sh` pour redémarrer avec la nouvelle configuration.

> L'envoi passe par FCM HTTP v1 avec un jeton OAuth signé par
> `google-auth-library`, déjà présent pour vérifier les ID tokens Google.
> `firebase-admin` aurait apporté des dizaines de mégaoctets pour le seul
> endpoint réellement appelé ici.

La pile Docker Compose contient quatre services :

- **`db`** — PostgreSQL 17, volume persistant, healthcheck ;
- **`api`** — cette application, migrations appliquées au démarrage par
  `docker-entrypoint.sh` ;
- **`admin`** — le [backoffice](#le-backoffice), même image, publié sur la
  seule boucle locale et donc absent d'Internet ;
- **`caddy`** — reverse proxy, **certificat Let's Encrypt obtenu et renouvelé
  automatiquement** (aucune tâche cron certbot à maintenir).

### Firewall

Seul Caddy publie des ports **vers l'extérieur**. PostgreSQL et l'API restent
sur le réseau Docker interne et ne sont **jamais** exposés à Internet ; le
backoffice publie sur `127.0.0.1` uniquement, ce qui revient au même vu du
dehors. UFW n'a donc besoin que de :

```
2222/tcp   ssh
80/tcp     http (challenge ACME + redirection)
443/tcp    https
```

> Attention : les ports publiés par Docker contournent UFW en écrivant
> directement dans netfilter. Ici les deux configurations coïncident (80/443),
> mais ajouter un `ports:` à un service l'exposerait sans que UFW ne l'indique.
> C'est pour cette raison exactement que celui du backoffice porte une adresse
> de liaison, `127.0.0.1:4000:4000`, et pas seulement un numéro de port.

---

## Tests

323 tests d'intégration qui traversent tout le serveur via `app.inject()`, avec
des doublures pour Google, Apple, Resend et FCM, et une vraie base PostgreSQL —
plus quatre cas dédiés à la minimisation des emails (JWT, membres de table,
joueur sans nom, 404).

Le [backoffice](#le-backoffice) en occupe quatre-vingt-neuf. Cinq épinglent la
séparation des deux API — elles ne portent pas les routes l'une de l'autre, et
celle d'administration n'autorise aucune origine navigateur. Neuf couvrent les
deux primitives écrites à la main, **dont les vecteurs de référence de la
RFC 6238** : c'est ce qui rend défendable de ne pas avoir pris de
bibliothèque. Vingt et un suivent la connexion — même réponse à tous les refus,
code rejoué, verrouillage, session révoquée, expirée, glissante, et le journal
d'audit, y compris qu'aucun secret n'y entre jamais.

Quinze suivent la file des signalements, et **les dossiers y naissent par l'API
du produit** plutôt que fabriqués à la main : c'est le seul moyen que la file
lise ce qu'un joueur dépose vraiment. L'un d'eux renomme la table après coup et
vérifie que le dossier dit toujours ce qu'elle disait — c'est toute la raison
d'être de l'instantané.

Quatorze portent l'écriture du catalogue. Deux valent plus que les autres :
l'un vérifie qu'un personnage corrigé **garde son identifiant** quand celui
qu'on a retiré disparaît, l'autre qu'un indice supprimé emporte ses remises et
que le journal en donne le compte. Un troisième écrit une aventure par le
backoffice et va la lire **par l'API du produit**, seule preuve que l'écran
remplace vraiment l'`INSERT` de migration.

Vingt portent les sanctions, et **quatre d'entre eux valent pour
toute la carte** : ils vérifient qu'une suspension mord au jeton d'accès déjà
en main, à la reconnexion Google, à la reconnexion Apple et au
rafraîchissement. Un cinquième pose la suspension en base sans révoquer les
jetons, pour couvrir seul le cas que la révocation rate.

```bash
docker compose -f docker-compose.dev.yml up -d
docker exec questbook-back-db-1 psql -U questbook -d questbook -c "CREATE DATABASE questbook_test"
TEST_DATABASE_URL=postgresql://questbook:questbook@localhost:5432/questbook_test npx prisma migrate deploy
npm test
```

Couverture : création de compte et réutilisation, rotation et rejeu du refresh
token, hachage des jetons, isolation stricte entre comptes (404 plutôt que 403
pour ne pas divulguer l'existence d'un identifiant), **minimisation des emails**
(un membre ne voit jamais la boîte d'un autre, le JWT ne porte que `sub`), CRUD inventaire, bornage
des ressources, les quatre scénarios de synchronisation (création, remplacement
d'agrégat, conflit périmé, propagation des tombstones), et tout le périmètre
des tables : invitation d'une adresse inconnue (e-mail d'installation, rattachement
à la première connexion), plafond de 8 joueurs et de 15 invitations par jour,
acceptation par le lien
web et depuis l'app, rejeu impossible, révocation, autorisations MJ/joueur,
création et modification de sessions, changements de participation, et
vérification que chaque événement produit bien la notification et l'e-mail
attendus via les doublures. Côté boutique : catalogue visible en entier,
description réservée au détail, achat qui rend l'article possédé sans
contaminer les autres comptes, second achat sans erreur ni ligne en double,
achat d'un scénario qui le fait apparaître dans `/scenarios`, et refus d'un
article payant comme d'un `pack`.

Les suites partagent une base et la vident entre chaque test : elles s'exécutent
donc en série (`fileParallelism: false`).

### En intégration continue

`.github/workflows/ci.yml` rejoue `npm run typecheck` puis `npm test` sur chaque
pull request et sur les pushes de `dev`. PostgreSQL y tourne en service du job
et les migrations versionnées sont appliquées avec `prisma migrate deploy`,
c'est-à-dire exactement la commande qui s'exécutera en production.

Aucun service tiers n'est sollicité : `RESEND_API_KEY` et les variables Firebase
restent vides, donc les envois retombent sur leur mode journal.

Ce garde-fou compte double ici, puisqu'un merge dans `main` part directement en
production, migrations comprises.
