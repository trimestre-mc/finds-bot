# finds-bot

Bot Discord qui indexe automatiquement des boutiques Weidian, permet de chercher dans les items et de les poster avec tes liens d'affiliation d'agents.

- **Bot** : Cloudflare Worker (gratuit, 24h/24) — `https://finds-bot.wheatenmoon5861.workers.dev`
- **Base** : Cloudflare D1
- **Traduction des titres** : Workers AI (chinois → anglais)
- **Indexeur** : GitHub Actions toutes les 30 min (Chromium sans fenêtre, ouvre les boutiques comme un visiteur)

## Commandes

| Commande | Rôle |
|---|---|
| `/catalogue ajouter lien:` | Ajoute une boutique Weidian (lien de boutique ou d'un de ses items) |
| `/catalogue liste` / `retirer` / `reindexer` | Gère les catalogues |
| `/recherche mots: salon: prix_min: prix_max: vendeur: inclure_postes:` | Cherche, puis poste les items choisis ou tout d'un coup |
| `/item ajouter lien: titre: prix: image:` | Ajoute un item à la main (Taobao, 1688, ou Weidian) |
| `/agent ajouter nom: modele: position:` | Lien d'affiliation, ex. `https://agent.com/product?url={url}&code=TONCODE` |
| `/admin ajouter` / `retirer` / `liste` | Donne l'accès à d'autres membres |
| `/statut` | Items, traductions en attente, file d'envoi |

Accès : le propriétaire et les membres avec la permission **Administrateur**, plus les membres ajoutés avec `/admin ajouter`.

Variables du modèle d'agent : `{url}` (lien produit encodé), `{url_raw}`, `{id}`, `{platform}`.

## Installation Discord

1. Sur https://discord.com/developers/applications → **New Application**.
2. Copie l'**Application ID** et la **Public Key** (onglet General Information) dans `wrangler.toml` (`DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`).
3. Onglet **Bot** → **Reset Token**, puis dans un terminal :
   `npx wrangler secret put DISCORD_BOT_TOKEN` (colle le token quand c'est demandé — jamais dans le chat ni dans le code).
4. `npx wrangler deploy`
5. Onglet General Information → **Interactions Endpoint URL** :
   `https://finds-bot.wheatenmoon5861.workers.dev/interactions` → Save.
6. Enregistrer les commandes :
   `curl -X POST -H "Authorization: Bearer $(cat .secrets)" https://finds-bot.wheatenmoon5861.workers.dev/api/register-commands`
7. Inviter le bot (remplace APP_ID) :
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=19456`
   (Voir les salons, Envoyer des messages, Intégrer des liens.)

## Indexation immédiate (optionnel)

Par défaut, un nouveau catalogue est indexé au prochain passage (30 min max). Pour lancer l'indexeur tout de suite, crée un token GitHub *fine-grained* limité à ce repo avec la permission **Actions: write**, puis :
`npx wrangler secret put GITHUB_TOKEN` et décommente `GITHUB_REPO` dans `wrangler.toml`.

## Limites

- Taobao et 1688 exigent une connexion : pas d'indexation automatique, seulement `/item ajouter`.
- Si Weidian demande une vérification, l'indexeur s'arrête (rien n'est contourné) et réessaie au passage suivant.
- Traduction : ~10 titres/min (quota gratuit Workers AI). Les items sont cherchables en chinois en attendant.

## Tests

`npm test` (liens) · `npm run test:e2e` (Worker local + faux Discord + vraie indexation Weidian)
