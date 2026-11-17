# MandatoRappel v2

Synchronise automatiquement les matchs Valorant de **MDR** (Challengers France) dans un calendrier iCloud, et t'envoie des notifications push sur iPhone : nouveau match, match déplacé, résultat, panne.

## Ce qui change par rapport à la v1

| | v1 | v2 |
|---|---|---|
| Source | Navigateur Playwright qui clique sur le site | **API JSON officielle** du site (simple requête HTTP), navigateur seulement en secours |
| Durée d'un run | ~1–2 min | quelques secondes |
| Fréquence | 1 fois/jour (souvent décalé de plusieurs heures) | **toutes les heures** de 7h à 23h |
| Runner | `ubuntu-latest` (cassé par Ubuntu 26.04) | `ubuntu-24.04` figé |
| Notifications | « 2 événements créés » chaque jour | Détaillées par match, aucune notif si rien ne change |
| Pannes | Silencieuses | Alerte push (1 fois par jour max) |
| Matchs annulés | Restent dans le calendrier | Supprimés (après 3 vérifications) + notif |
| Résultats | — | Titre mis à jour `✅ MDR 2–1 Joblife` + notif |
| État | Commité sur `main` avec tes URL iCloud | Branche `state` séparée, aucune donnée iCloud |

## Format des événements

- **Titre** : `MDR vs Joblife`, puis `✅ MDR 2–1 Joblife` / `❌ MDR 0–2 Joblife` une fois joué
- **Lieu** : `Challengers France · Semaine 4 · BO3`
- **Horaires** : début 30 min avant le match ; fin estimée selon le format (BO1 ≈ 1 h, BO3 ≈ 2 h 30, BO5 ≈ 4 h) + 30 min
- **Rappels** : 1 jour avant et 1 heure avant l'heure officielle
- **Notes** : compétition, format, heure officielle, adversaire et son bilan, liens Twitch et site officiel
- **URL** : le stream Twitch (tap direct depuis l'app Calendrier)

## Installation

### 1. Secrets (Settings → Secrets and variables → Actions → *Secrets*)

| Secret | Valeur |
|---|---|
| `ICLOUD_USERNAME` | Ton identifiant Apple (e-mail) |
| `ICLOUD_APP_PASSWORD` | Un [mot de passe pour app](https://account.apple.com) (Connexion et sécurité → Mots de passe pour app) |

### 2. Variables (même écran, onglet *Variables*) — toutes optionnelles

| Variable | Défaut | Rôle |
|---|---|---|
| `ICLOUD_CALENDAR_NAME` | `Matchs Mandatory` | Calendrier cible (doit exister et être modifiable) |
| `TEAM_NAME` | `MDR` | Code de l'équipe suivie |
| `TEAM_ALIASES` | `Mandatory` | Autres noms de l'équipe, séparés par des virgules |
| `LEAGUES` | `Challengers France` | Ligues à surveiller, séparées par des virgules (ex. `Challengers France,Ascension EMEA`) |
| `LEAGUE_IDS` | — | IDs de ligue Riot, pour forcer la sélection |
| `STREAM_URL` | `https://www.twitch.tv/zerator` | Lien du stream |
| `NOTIFY_RESULTS` | `true` | Notifier les résultats |
| `NOTIFY_BACKENDS` | — | Services de notification, ex. `ntfy` ou `ntfy,pushcut` |

### 3. Désactiver la v1

Dans l'ancien dépôt : **Actions → Sync MDR matches to iCloud → ⋯ → Disable workflow**. Sinon les deux versions écrivent dans le même calendrier.

Au premier lancement, la v2 remplace les événements **à venir** créés par la v1 (même heure de match) par les siens. Les matchs passés ne sont pas touchés.

### 4. Lancer

**Actions → Sync MDR → iCloud → Run workflow**. Coche « Essai à blanc » pour un premier test sans rien écrire.

## Notifications push

### ntfy (recommandé : gratuit, sans compte)

1. Installe l'app **ntfy** (App Store) sur l'iPhone.
2. Abonne-toi à un sujet au nom long et imprévisible (ex. `mdr-sirlian-8f3k2q9x`) : sur ntfy.sh, quiconque connaît le nom peut lire le sujet.
3. Secret `NOTIFY_NTFY_TOPIC` = ce nom ; variable `NOTIFY_BACKENDS` = `ntfy`.
4. Lance le workflow avec **« Envoyer seulement une notification de test »**.

Chaque notification ouvre Twitch au tap, avec un bouton « Ouvrir Twitch ».

### Pushcut (pour l'app Raccourcis)

Secrets `NOTIFY_PUSHCUT_API_KEY` et `NOTIFY_PUSHCUT_NOTIFICATION_KEY` (nom de la notification Pushcut), ajoute `pushcut` à `NOTIFY_BACKENDS`.

La notification transmet au raccourci associé un JSON en entrée :

```json
{
  "kind": "new",
  "title": "🆕 MDR vs Joblife",
  "body": "Demain à 20:00 · BO3\nChallengers France · Semaine 4",
  "url": "https://www.twitch.tv/zerator",
  "match": { "id": "…", "start": "2026-11-13T19:00:00.000Z", "opponent": "Joblife", "opponentCode": "JL", "bestOf": 3, "competition": "Challengers France · Semaine 4", "status": "upcoming", "score": null, "outcome": null }
}
```

`kind` vaut `new`, `rescheduled`, `updated`, `result`, `removed`, `digest`, `error`, `fallback` ou `test`. Dans Raccourcis : *Obtenir le dictionnaire depuis l'entrée*, puis par exemple *Si kind est result* → *Énoncer le texte*.

### Autres services

| Service | Secrets | `NOTIFY_BACKENDS` |
|---|---|---|
| Pushover | `NOTIFY_PUSHOVER_API_TOKEN`, `NOTIFY_PUSHOVER_USER_KEY` | `pushover` |
| Telegram | `NOTIFY_TELEGRAM_BOT_TOKEN`, `NOTIFY_TELEGRAM_CHAT_ID` | `telegram` |
| Discord | `NOTIFY_DISCORD_WEBHOOK_URL` | `discord` |
| Webhook (IFTTT, Zapier…) | `NOTIFY_WEBHOOK_URL` | `webhook` |

Pour ntfy auto-hébergé : variable `NOTIFY_NTFY_SERVER` et secret `NOTIFY_NTFY_TOKEN`.

## Raccourci « Quand joue MDR ? » (sans rien configurer)

Dans Raccourcis : *Rechercher des événements du calendrier* (calendrier « Matchs Mandatory », date de début après maintenant, trier par date de début, limite 1) → *Énoncer* le titre et la date. Nomme-le « Quand joue MDR » pour le lancer avec Siri.

Le workflow publie aussi `matches.json` (prochain match, matchs à venir, derniers résultats) sur la branche `state`. Si le dépôt est public, un raccourci peut le lire avec *Obtenir le contenu de l'URL* sur `https://raw.githubusercontent.com/<compte>/<dépôt>/state/matches.json`.

## Fonctionnement

1. Récupère les ligues puis le planning via l'API utilisée par valorantesports.com.
2. Ne garde que les matchs de MDR avec un adversaire connu.
3. Compare avec l'état (branche `state`) : crée, met à jour ou supprime les événements iCloud.
4. Envoie les notifications, sauvegarde l'état (un seul commit, réécrit seulement si quelque chose change).

Si l'API ne répond pas, le workflow installe Chromium et bascule sur le scraping de la v1, avec une notification « mode secours ». En mode secours, aucun match n'est supprimé.

L'API n'est pas documentée publiquement. Si Riot la modifie, le secours prend le relais et tu es prévenu ; l'URL et la clé sont surchargeables (`RIOT_ESPORTS_API_BASE`, `RIOT_ESPORTS_API_KEY`).

## Publier sur GitHub / envoyer une mise à jour

Depuis ce dossier, dans le Terminal :

```bash
./publier.sh
```

Le script envoie tout sur `SirlianCassar/MandatoRappel-v2` (le crée en privé si GitHub CLI est installé), et ne pousse que s'il y a des changements. Ça marche aussi depuis un nouveau .zip décompressé : il repart de la version en ligne.

- Message personnalisé : `./publier.sh "Ajout de l'Ascension EMEA"`
- Autre dépôt : `REPO=SirlianCassar/MandatoRappel ./publier.sh`

## Développement

```bash
npm ci
npm test            # tests unitaires (données simulées)
npm run typecheck

# Essai réel sans écrire sur iCloud
ICLOUD_USERNAME=… ICLOUD_APP_PASSWORD=… DRY_RUN=true DEBUG=true npm run sync
```
