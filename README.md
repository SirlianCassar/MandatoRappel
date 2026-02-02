## MandatoRappel — Sync des matchs MDR vers iCloud (CalDAV)

Ce dépôt exécute **tous les jours à midi (Europe/Paris)** un script qui :

- scrape `https://valorantesports.com/fr-FR/` avec **Playwright** (site dynamique)
- détecte uniquement les **matchs complets** de l’équipe **MDR**
- crée / met à jour automatiquement les événements dans **Calendrier iCloud (CalDAV)**
- persiste un état dans `data/state.json` pour éviter les doublons et gérer les mises à jour

## Règles métier appliquées

Un match est **ajouté / synchronisé** uniquement si :

- **MDR** est l’une des deux équipes (`TEAM_NAME`)
- **l’adversaire est connu** (≠ `TBD`, ≠ vide)
- **la date et l’heure sont définies**
- **le tournoi est défini** (sinon match considéré incomplet)

Ne jamais ajouter :

- match sans adversaire
- match incomplet
- doublon

## Format exact des événements iCloud

- **Titre** : `MDR VS ADVERSAIRE`
- **Lieu** : `BOx — NOM DU TOURNOI` (BO affiché uniquement si connu, sinon uniquement le tournoi)
- **Notes** (strictement 2 lignes) :

```
https://www.twitch.tv/zerator
https://valorantesports.com/fr-FR/
```

- **Rappels** :
  - toujours **1 heure avant**
  - **+ 1 jour avant** si le match n’est **pas aujourd’hui** (Europe/Paris)

- **Décalage de l'événement** :
  - l'heure de **début** est mise à **-30 minutes** de l'heure officielle
  - l'heure de **fin** est mise à **+1 heure** par rapport à la fin officielle (durée officielle par défaut: 2h)

## Fonctionnement (dédup + mises à jour)

- Le script calcule un **matchId “métier”** basé sur : **date/heure + MDR + adversaire + tournoi**
- Il calcule aussi un **UID/clé d’événement stable** (basée sur l’URL du match quand disponible) pour garantir :
  - mise à jour de l’événement si **date/heure/adversaire/BO/tournoi** change
  - pas de création de doublons lors des changements

L’état est stocké dans `data/state.json` et est **commité automatiquement** par GitHub Actions.

## Configuration (GitHub Secrets)

Dans votre repo GitHub : `Settings` → `Secrets and variables` → `Actions` → `New repository secret`

- **ICLOUD_USERNAME** : votre identifiant iCloud (email Apple)
- **ICLOUD_APP_PASSWORD** : mot de passe d’app spécifique iCloud (Apple ID → Sécurité)
- **TEAM_NAME** : `MDR` (ou autre si vous voulez cibler une autre équipe)

Optionnel (variable d'environnement) :

- **ICLOUD_CALENDAR_NAME** : nom exact du calendrier iCloud à cibler (sinon : 1er calendrier détecté).  
  Dans le workflow GitHub Actions, le calendrier est forcé à **Matchs Mandatory**.
- **DRY_RUN** : `true` ou `1` pour tester sans écrire sur iCloud
- **FORCE_RUN** : `true` ou `1` pour exécuter immédiatement (optionnel)
- **DEBUG_SCRAPE** : `true` ou `1` pour afficher des logs utiles au debugging du scraping

Note: pour `TEAM_NAME=MDR`, le scraper officiel applique automatiquement le filtre `Toutes les ligues → Challengers France`
afin d'obtenir le calendrier complet (incluant le BO).

Important: certains calendriers iCloud peuvent être **non modifiables** (partagés/abonnés).  
Le script sélectionne automatiquement un calendrier **writable** qui supporte `VEVENT`. Si `ICLOUD_CALENDAR_NAME` pointe vers
un calendrier non writable, il affichera un warning (ou échouera si aucun calendrier writable n'est disponible).

## Exécution locale

Prérequis : **Node.js 20+**

```bash
npm ci
npx playwright install chromium

export ICLOUD_USERNAME="..."
export ICLOUD_APP_PASSWORD="..."
export TEAM_NAME="MDR"

npm run start
```

## GitHub Actions (planification midi Europe/Paris)

Le workflow `.github/workflows/sync.yml` est planifié à **10:00 UTC** (soit **midi Europe/Paris en été**).
En hiver, l’exécution sera à **11:00 Europe/Paris**. Le script ne bloque plus sur l’heure, donc une exécution manuelle fonctionne à tout moment.

Pour tester manuellement à n’importe quelle heure, lance le workflow via **Run workflow** (optionnel : `dry_run: true`).

## Notifications

**Notifications iOS/iCloud** : Les événements créés/modifiés via CalDAV externe (comme ce script) ne déclenchent **pas toujours** des notifications push iOS. C'est une limitation connue d'iOS/iCloud.

**Notifications push (recommandé)** : Le script supporte plusieurs backends de notifications pour te prévenir quand des événements sont créés/modifiés :

### Telegram Bot (recommandé, gratuit et simple)

1. Créer un bot Telegram :
   - Ouvrir Telegram et chercher `@BotFather`
   - Envoyer `/newbot` et suivre les instructions
   - Récupérer le **token du bot** (ex: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
2. Obtenir ton `chat_id` :
   - Envoyer un message à ton bot
   - Visiter `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Chercher `"chat":{"id":123456789}` → c'est ton `chat_id`
3. Ajouter les secrets GitHub :
   - `NOTIFY_BACKEND`: `telegram`
   - `NOTIFY_TELEGRAM_BOT_TOKEN`: le token du bot
   - `NOTIFY_TELEGRAM_CHAT_ID`: ton chat_id

### Discord Webhook

1. Discord → serveur → `Paramètres` → `Intégrations` → `Webhooks` → `Nouveau webhook`
2. Copier l'URL du webhook
3. Ajouter les secrets GitHub :
   - `NOTIFY_BACKEND`: `discord`
   - `NOTIFY_DISCORD_WEBHOOK_URL`: l'URL du webhook

### Pushover (payant, 5$ one-time, très fiable)

1. Créer un compte sur [pushover.net](https://pushover.net)
2. Récupérer ton **User Key** depuis le dashboard
3. Créer une application → récupérer l'**API Token**
4. Ajouter les secrets GitHub :
   - `NOTIFY_BACKEND`: `pushover`
   - `NOTIFY_PUSHOVER_API_TOKEN`: l'API token
   - `NOTIFY_PUSHOVER_USER_KEY`: ton User Key

### Pushcut (iOS Shortcuts — recommandé pour iOS)

**Pushcut** permet d'envoyer des notifications push iOS qui déclenchent automatiquement des **Shortcuts iOS**.

1. Installer l'app **Pushcut** sur iOS ([App Store](https://apps.apple.com/app/pushcut/id1450936447))
2. Dans Pushcut :
   - Créer une **Notification** (ou utiliser une existante)
   - Configurer l'action : **"Run Shortcut"** → sélectionner ton Shortcut iOS
   - Récupérer la **Notification Key** (ex: `abc123xyz`)
3. Récupérer ton **API Key** :
   - Pushcut → `Settings` → `API Keys` → `Create API Key`
4. Ajouter les secrets GitHub :
   - `NOTIFY_BACKEND`: `pushcut`
   - `NOTIFY_PUSHCUT_API_KEY`: ton API key
   - `NOTIFY_PUSHCUT_NOTIFICATION_KEY`: la notification key

**Créer le Shortcut iOS** :
- Ouvrir l'app **Shortcuts** sur iOS
- Créer un nouveau Shortcut
- Ajouter des actions (ex: `Afficher une notification`, `Lire un texte`, etc.)
- Le Shortcut sera automatiquement déclenché quand la notification Pushcut arrive

**Alternative : Webhook générique** (pour services tiers comme IFTTT, Zapier, etc.)

Si tu utilises **IFTTT**, **Zapier**, ou un autre service qui peut déclencher des Shortcuts iOS :
1. Configurer un webhook dans ton service
2. Ajouter les secrets GitHub :
   - `NOTIFY_BACKEND`: `webhook`
   - `NOTIFY_WEBHOOK_URL`: l'URL du webhook

### Désactiver les notifications

- `NOTIFY_BACKEND`: `none` (ou ne pas définir la variable)

**Notifications GitHub Actions** : GitHub envoie automatiquement des **emails en cas d'échec** du workflow. Le workflow affiche aussi un résumé dans l'onglet "Actions" de GitHub après chaque exécution.

## Dépannage

- Si aucun match n'est créé alors que vous en voyez sur le site, c'est généralement un problème de scraping (structure du site modifiée).
  - Dans ce cas, ouvrez une issue et joignez la sortie des logs GitHub Actions.
- Si la connexion iCloud échoue : vérifiez le **mot de passe d'app** et que CalDAV est autorisé sur le compte.
- **Le workflow ne se lance pas automatiquement** : Vérifiez que le workflow est activé dans `Actions` → `Workflows` → `Sync MDR matches to iCloud (CalDAV)`
