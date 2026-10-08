# Déployer Plan Vivant sur un VPS

Version 1 : plan interactif (RDC et 2ᵉ étage), fiche par lot (occupation, travaux, DPE), commentaires internes ou partagés, journal des modifications, export Excel, comptes « gestion » et « lecture ».

## Ce qu'il faut

- Un VPS Linux (Debian 12 ou Ubuntu 22.04/24.04), 1 Go de RAM suffit, ports **80** et **443** ouverts.
- Un nom de domaine ou sous-domaine (par exemple `plan.mondomaine.fr`) avec un enregistrement DNS **A** vers l'IP du VPS. Le certificat HTTPS est obtenu automatiquement par Caddy dès que le DNS pointe vers le serveur.
- Si un autre site tourne déjà sur le VPS (nginx, Apache…) et occupe les ports 80/443, voir « VPS déjà occupé » plus bas.

## Installation (une fois)

```sh
# 1. Récupérer le code (dépôt privé : utiliser un jeton GitHub ou une clé de déploiement)
sudo mkdir -p /opt/plan-vivant && sudo chown "$USER" /opt/plan-vivant
git clone -b claude/plan-immeuble-dynamique-1m1vbw https://github.com/penotdev-code/cave.git /opt/plan-vivant
cd /opt/plan-vivant/app

# 2. Installer Docker si besoin, démarrer, créer le premier compte
sudo sh installer.sh plan.mondomaine.fr gestionnaire@exemple.fr "Prénom Nom"
```

Le script affiche le mot de passe du premier compte. Transmettez-le par un canal sûr (SMS, en personne), pas dans le même e-mail que l'adresse du site.

## Gérer les comptes

Depuis `/opt/plan-vivant/app` :

```sh
alias pv='sudo docker compose exec app node --disable-warning=ExperimentalWarning server/cli.js'
pv ajouter bailleur@organisme.fr lecture "Bailleur social"   # organisme partenaire : lecture seule
pv ajouter assistante@exemple.fr gestion "Assistante"         # peut modifier
pv liste
pv mot-de-passe bailleur@organisme.fr                         # nouveau mot de passe, déconnecte la personne
pv role bailleur@organisme.fr gestion
pv supprimer bailleur@organisme.fr
```

| Rôle | Voit | Peut modifier | Commentaires | Journal | Export |
|---|---|---|---|---|---|
| `gestion` | tout | occupation, travaux, DPE, commentaires | internes et partagés | oui | oui (avec journal) |
| `lecture` | plan, états, alertes | rien | partagés seulement | non | oui (sans journal ni commentaires internes) |

## Mettre à jour

```sh
cd /opt/plan-vivant && git pull && cd app && sudo docker compose up -d --build
```

Les données sont dans le volume Docker `app_data` et ne sont pas touchées par une mise à jour.

## Sauvegardes

```sh
sudo crontab -e
# ajouter :
0 3 * * * /opt/plan-vivant/app/sauvegarde.sh
```

Une copie de la base est écrite chaque nuit dans `/opt/plan-vivant/app/sauvegardes/` (30 jours conservés). Pensez à copier ce dossier hors du VPS de temps en temps.

Restaurer une sauvegarde :

```sh
sudo docker compose stop app
sudo docker compose cp sauvegardes/plan-vivant-AAAA-MM-JJ.sqlite app:/data/plan-vivant.sqlite
sudo docker compose start app
```

## VPS déjà occupé (nginx existant)

Ne pas lancer Caddy : démarrer seulement l'application en l'exposant sur la machine.

```sh
sudo docker compose -f compose.yaml -f compose.nginx.yaml up -d --build app
```

Créer ensuite le premier compte avec la commande `pv ajouter … gestion …` ci-dessous.

Puis, dans nginx, un `server` pour le domaine avec :

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;   # mises à jour en direct
    proxy_read_timeout 1h;
}
```

et un certificat avec `certbot --nginx -d plan.mondomaine.fr`.

## En cas de souci

```sh
sudo docker compose ps
sudo docker compose logs -f app      # application
sudo docker compose logs -f caddy    # certificat HTTPS, DNS
```

Si le certificat ne s'obtient pas : vérifier que le DNS pointe bien vers le VPS (`dig +short plan.mondomaine.fr`) et que les ports 80 et 443 sont ouverts dans le pare-feu de l'hébergeur.

## Limites de cette version

- Les plans de 800, 801, 102 et du 2ᵉ étage sont des schémas provisoires : ils seront remplacés par la conversion des fichiers AutoCAD (`public/plan.json`).
- Identifiants et surfaces ne sont connus que pour 8 lots : l'import complet de 30_LOCAUX est la prochaine étape.
- Les comptes se gèrent en ligne de commande ; pas encore d'écran d'administration ni de mot de passe oublié par e-mail.
