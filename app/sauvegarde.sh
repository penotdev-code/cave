#!/bin/sh
# Copie cohérente de la base, à lancer chaque nuit par cron (garde 30 jours).
#   0 3 * * * /opt/plan-vivant/app/sauvegarde.sh
set -eu
cd "$(dirname "$0")"
mkdir -p sauvegardes
docker compose exec -T app node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
new DatabaseSync('/data/plan-vivant.sqlite').exec(\"VACUUM INTO '/data/sauvegarde.sqlite'\");"
docker compose cp app:/data/sauvegarde.sqlite "sauvegardes/plan-vivant-$(date +%F).sqlite"
docker compose exec -T app rm -f /data/sauvegarde.sqlite
find sauvegardes -name 'plan-vivant-*.sqlite' -mtime +30 -delete
