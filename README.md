# Questbook — API

Backend de [questbook-app](https://github.com/Sraime/questbook-app) : connexion
via un compte Google, persistance des personnages (caractéristiques,
compétences, ressources, inventaire) sur un compte utilisateur, et gestion des
tables de jeu — membres, invitations par e-mail, sessions et notifications.

**Node.js 22 · Fastify 5 · Prisma 6 · PostgreSQL 17 · TypeScript**

UI et documentation en **français**, code et commentaires en **anglais**
(même convention que l'app Flutter).

---

## Sommaire

- [Architecture](#architecture)
- [Modèle de données](#modèle-de-données)
- [Authentification](#authentification)
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
├── config/env.ts             validation zod des variables d'environnement
├── lib/
│   ├── errors.ts             AppError + helpers (badRequest, notFound, conflict…)
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

Le gestionnaire d'erreurs central traduit tout en `{ "error": { "code", "message" } }`.

> ⚠️ Il est installé **avant** les `register` de routes. Fastify fige le
> gestionnaire d'erreurs au moment où chaque contexte encapsulé est créé : un
> `setErrorHandler` appelé après les `register` ne s'appliquerait jamais aux
> routes déjà enregistrées (piège déjà rencontré ici, 3 tests rouges à la clé).

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
| `game_tables`         | Table de jeu : titre, univers optionnel, MJ propriétaire          |
| `table_members`       | Appartenance et rôle (`gm` / `player`)                            |
| `table_invitations`   | Invitations, jeton stocké **haché** comme les refresh tokens      |
| `game_sessions`       | Séance : titre, description, date/heure, lieu, statut             |
| `session_attendances` | Réponses des joueurs (`yes` / `no`), une ligne par joueur         |
| `device_tokens`       | Jetons FCM, un par appareil                                       |
| `notifications`       | Historique consultable dans l'app                                 |

Les champs des personnages reproduisent exactement les modèles Freezed de l'app
(`Character`, `CharacterStat`, `CharacterResource`, `InventoryItem`). Les
tables, elles, n'ont pas d'équivalent local : elles sont partagées entre
plusieurs comptes et ne vivent que sur le serveur.

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
- Un email non vérifié par Google est refusé.

---

## Endpoints

Préfixe : `/api/v1`. Toutes les routes exigent l'en-tête
`Authorization: Bearer <accessToken>`, à la seule exception de la page web
d'acceptation d'invitation, servie hors préfixe (voir plus bas).

### Authentification

| Méthode | Route            | Description                                     |
| ------- | ---------------- | ----------------------------------------------- |
| `POST`  | `/auth/google`   | Inscription/connexion depuis un ID token Google |
| `POST`  | `/auth/refresh`  | Rotation du couple de jetons                    |
| `POST`  | `/auth/logout`   | Révoque le refresh token (204)                  |
| `GET`   | `/auth/me`       | Profil de l'utilisateur connecté                |

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
| `PATCH`  | `/tables/:id`                            | Titre et univers (MJ)                        |
| `DELETE` | `/tables/:id`                            | Dissolution (MJ, 204)                        |
| `DELETE` | `/tables/:id/members/me`                 | Quitter la table (204)                       |
| `DELETE` | `/tables/:id/members/:userId`            | Exclure un joueur (MJ, 204)                  |
| `POST`   | `/tables/:id/invitations`                | Inviter par e-mail (MJ, 201)                 |
| `DELETE` | `/tables/:id/invitations/:invitationId`  | Révoquer une invitation (MJ, 204)            |
| `GET`    | `/invitations`                           | Invitations reçues, en attente               |
| `POST`   | `/invitations/:id/accept`                | Accepter depuis l'app                        |
| `POST`   | `/invitations/:id/decline`               | Décliner (204)                               |

### Sessions et participation

| Méthode  | Route                          | Description                              |
| -------- | ------------------------------ | ---------------------------------------- |
| `GET`    | `/tables/:id/sessions`         | Sessions de la table                     |
| `POST`   | `/tables/:id/sessions`         | Proposer une session (MJ, 201)           |
| `GET`    | `/sessions/:id`                | Détail et réponses de chacun             |
| `PATCH`  | `/sessions/:id`                | Titre, description, date, lieu (MJ)      |
| `DELETE` | `/sessions/:id`                | Annulation — la session reste visible    |
| `PUT`    | `/sessions/:id/attendance`     | `{ "status": "yes" \| "no" }`, modifiable |

### Notifications et appareils

| Méthode  | Route                       | Description                                |
| -------- | --------------------------- | ------------------------------------------ |
| `GET`    | `/notifications`            | Historique + `unreadCount`                 |
| `POST`   | `/notifications/read`       | Marquer une liste d'identifiants lue (204) |
| `POST`   | `/notifications/read-all`   | Tout marquer lu (204)                      |
| `PUT`    | `/devices`                  | Enregistrer un jeton FCM (204)             |
| `DELETE` | `/devices/:token`           | Retirer un jeton, à la déconnexion (204)   |

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
                                             │  l'e-mail a-t-il un compte ?
                                             │  non → 404 "aucun joueur inscrit"
                                             │  oui → invitation + notification
                                             ├──▶ Resend : lien /invitations/:token
Joueur ──GET /invitations/:token────────────▶│  page HTML avec un bouton
Joueur ──POST /invitations/:token/accept────▶│  crée le TableMember
                                             └──▶ notification au MJ
```

Deux garde-fous expliquent la forme de ce flux :

- **Seuls les comptes existants sont invitables.** L'invitation porte donc
  toujours l'identifiant du joueur, ce qui permet au lien e-mail de fonctionner
  sans connexion : posséder le jeton fait autorité, comme pour n'importe quelle
  invitation par e-mail.
- **Le lien n'accepte rien en `GET`.** Les clients mail préchargent les liens ;
  seul le `POST` du bouton engage le joueur. Le jeton suit exactement le motif
  des refresh tokens : 48 octets aléatoires envoyés, hachage SHA-256 stocké, et
  ajouté à la liste `redact` du logger.

L'invitation reste par ailleurs visible et acceptable directement dans l'app.

### Autorisations

Une garde d'appartenance renvoie **404** — et non 403 — pour une table dont on
n'est pas membre, comme pour les personnages : un appelant ne doit pas pouvoir
deviner quels identifiants existent. Une fois l'appartenance établie, un joueur
qui tente une action réservée au MJ reçoit un 403 : cacher la raison n'aurait
plus d'intérêt.

### Notifications

Cinq événements : invitation reçue, invitation acceptée, session créée, session
modifiée (date ou lieu **seulement** — corriger une faute dans la description ne
réveille personne), et participation confirmée ou changée.

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
   ```

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

La pile Docker Compose contient trois services :

- **`db`** — PostgreSQL 17, volume persistant, healthcheck ;
- **`api`** — cette application, migrations appliquées au démarrage par
  `docker-entrypoint.sh` ;
- **`caddy`** — reverse proxy, **certificat Let's Encrypt obtenu et renouvelé
  automatiquement** (aucune tâche cron certbot à maintenir).

### Firewall

Seul Caddy publie des ports. PostgreSQL et l'API restent sur le réseau Docker
interne et ne sont **jamais** exposés à Internet. UFW n'a donc besoin que de :

```
2222/tcp   ssh
80/tcp     http (challenge ACME + redirection)
443/tcp    https
```

> Attention : les ports publiés par Docker contournent UFW en écrivant
> directement dans netfilter. Ici les deux configurations coïncident (80/443),
> mais ajouter un `ports:` à un service l'exposerait sans que UFW ne l'indique.

---

## Tests

62 tests d'intégration qui traversent tout le serveur via `app.inject()`, avec
des doublures pour Google, Resend et FCM, et une vraie base PostgreSQL.

```bash
docker compose -f docker-compose.dev.yml up -d
docker exec questbook-back-db-1 psql -U questbook -d questbook -c "CREATE DATABASE questbook_test"
TEST_DATABASE_URL=postgresql://questbook:questbook@localhost:5432/questbook_test npx prisma migrate deploy
npm test
```

Couverture : création de compte et réutilisation, rotation et rejeu du refresh
token, hachage des jetons, isolation stricte entre comptes (404 plutôt que 403
pour ne pas divulguer l'existence d'un identifiant), CRUD inventaire, bornage
des ressources, les quatre scénarios de synchronisation (création, remplacement
d'agrégat, conflit périmé, propagation des tombstones), et tout le périmètre
des tables : invitation d'une adresse inconnue refusée, acceptation par le lien
web et depuis l'app, rejeu impossible, révocation, autorisations MJ/joueur,
création et modification de sessions, changements de participation, et
vérification que chaque événement produit bien la notification et l'e-mail
attendus via les doublures.

Les suites partagent une base et la vident entre chaque test : elles s'exécutent
donc en série (`fileParallelism: false`).
