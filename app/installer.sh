#!/bin/sh
# Installation de Plan Vivant sur un VPS Debian/Ubuntu, à lancer depuis le dossier app/ du dépôt :
#   sudo sh installer.sh plan.mondomaine.fr gestionnaire@exemple.fr "Nom affiché"
set -eu
DOMAIN="${1:?Usage : sudo sh installer.sh <domaine> <email du premier compte> [\"Nom\"]}"
EMAIL="${2:?Indiquez l'e-mail du premier compte gestionnaire}"
NAME="${3:-Gestion}"
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "→ Installation de Docker"
  curl -fsSL https://get.docker.com | sh
fi

echo "DOMAIN=$DOMAIN" > .env

echo "→ Construction et démarrage (le certificat HTTPS est obtenu automatiquement)"
docker compose up -d --build

echo "→ Attente du démarrage de l'application"
i=0; until docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i+1)); [ "$i" -gt 30 ] && { echo "L'application ne répond pas : docker compose logs app"; exit 1; }; sleep 2
done

if docker compose exec -T app node --disable-warning=ExperimentalWarning server/cli.js liste | grep -q .; then
  echo "→ Des comptes existent déjà, aucun compte créé."
else
  echo "→ Création du premier compte"
  docker compose exec -T app node --disable-warning=ExperimentalWarning server/cli.js ajouter "$EMAIL" gestion "$NAME"
fi

echo
echo "Plan Vivant est en ligne : https://$DOMAIN"
