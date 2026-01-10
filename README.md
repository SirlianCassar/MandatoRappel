## MandatoRappel — Sync des matchs MDR vers iCloud (CalDAV)

Ce dépôt exécute **tous les jours à 13h (Europe/Paris)** un script qui :

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
  - **+ 1 jour avant** si l’événement est créé/maj **≥ 48h avant** le début (ou si déjà présent)

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

Optionnel (variable d’environnement) :

- **ICLOUD_CALENDAR_NAME** : nom exact du calendrier iCloud à cibler (sinon : 1er calendrier détecté)
- **DRY_RUN** : `true` ou `1` pour tester sans écrire sur iCloud
- **FORCE_RUN** : `true` ou `1` pour exécuter immédiatement (ignore le gating 13h Europe/Paris)
- **DEBUG_SCRAPE** : `true` ou `1` pour afficher des logs utiles au debugging du scraping

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

## GitHub Actions (planification 13h Europe/Paris)

Le workflow `.github/workflows/sync.yml` est planifié à **11:00 et 12:00 UTC**.
Le script vérifie ensuite l’heure locale **Europe/Paris** et ne s’exécute réellement qu’à **13h**, ce qui rend le planning **compatible heure d’été / hiver**.

Pour tester manuellement à n’importe quelle heure, lance le workflow via **Run workflow** avec :

- `force_run: true`
- (optionnel) `dry_run: true`

## Dépannage

- Si aucun match n’est créé alors que vous en voyez sur le site, c’est généralement un problème de scraping (structure du site modifiée).
  - Dans ce cas, ouvrez une issue et joignez la sortie des logs GitHub Actions.
- Si la connexion iCloud échoue : vérifiez le **mot de passe d’app** et que CalDAV est autorisé sur le compte.


