#!/usr/bin/env bash
# Publie le contenu de ce dossier sur GitHub (premier envoi ou mise à jour).
#
#   ./publier.sh                       → envoie sur SirlianCassar/MandatoRappel-v2
#   ./publier.sh "Mon message"         → idem, avec un message de commit
#   REPO=compte/depot ./publier.sh     → envoie sur un autre dépôt
#
# Prérequis : git. Optionnel : GitHub CLI (gh), qui crée le dépôt s'il n'existe pas.
set -euo pipefail

REPO="${REPO:-SirlianCassar/MandatoRappel-v2}"
BRANCH="main"
MESSAGE="${1:-Mise à jour MandatoRappel v2 ($(date '+%d/%m/%Y %H:%M'))}"
URL="${URL:-https://github.com/${REPO}.git}"

cd "$(dirname "$0")"
command -v git >/dev/null || { echo "❌ git n'est pas installé."; exit 1; }

# 1. Créer le dépôt s'il n'existe pas encore (si GitHub CLI est disponible)
if ! git ls-remote "$URL" >/dev/null 2>&1; then
  if command -v gh >/dev/null; then
    echo "➕ Création du dépôt privé $REPO…"
    gh repo create "$REPO" --private --description "Sync des matchs MDR vers iCloud (v2)"
  else
    echo "❌ Le dépôt $REPO est introuvable (ou tu n'y as pas accès)."
    echo "   Crée-le vide sur https://github.com/new, ou installe GitHub CLI (brew install gh && gh auth login)."
    exit 1
  fi
fi

# 2. Préparer git dans ce dossier
[ -d .git ] || git init -q -b "$BRANCH"
git remote remove origin 2>/dev/null || true
git remote add origin "$URL"
git checkout -q -B "$BRANCH" 2>/dev/null || true

# 3. Repartir de la version en ligne (s'il y en a une) sans toucher aux fichiers locaux
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git fetch -q origin "$BRANCH"
  git reset -q --soft FETCH_HEAD
fi

# 4. Committer et envoyer
git add -A
if git rev-parse -q --verify HEAD >/dev/null && git diff --cached --quiet; then
  echo "✅ Rien à envoyer : $REPO est déjà à jour."
  exit 0
fi
# Identité git par défaut si elle n'est pas configurée sur cet ordinateur
git config user.name >/dev/null || git config user.name "SirlianCassar"
git config user.email >/dev/null || git config user.email "SirlianCassar@users.noreply.github.com"
git commit -qm "$MESSAGE"
git push -u origin "$BRANCH"
echo "✅ Envoyé sur https://github.com/$REPO"
