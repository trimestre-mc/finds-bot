# finds-bot

Bot Discord de finds : il indexe automatiquement des milliers d'items Weidian (et des items Taobao / 1688 populaires),
les traduit, les classe, et les poste en belles cartes avec tes liens d'affiliation, à la main ou automatiquement.

- **Bot** : Cloudflare Worker (gratuit, 24 h/24) — `https://finds-bot.wheatenmoon5861.workers.dev`
- **Base** : Cloudflare D1 · **IA** : Workers AI (titres, recherche multilingue)
- **Indexeur** : GitHub Actions, 4 jobs en parallèle, lancés par le bot dès qu'il y a du travail

## Commandes

| Commande | Pour qui | Rôle |
|---|---|---|
| `/menu` | admins + membres ajoutés | Panneau complet (tout en boutons) |
| `/find recherche: categorie: prix_max:` | tout le monde | Chercher un item et l'acheter avec le bon lien |
| `/convert lien:` | tout le monde | Transformer n'importe quel lien Weidian / Taobao / 1688 / d'agent en boutons d'achat avec ton code |

## Le panneau `/menu`

**Trouver**
- 🔎 **Rechercher** (anglais, français ou chinois, prix min/max) · 🔥 **Tendances** (les plus vendus) · ✨ **Nouveautés** · 📉 **Baisses de prix**
- 🎛️ **Filtres** : catégorie (chaussures, hoodies, t-shirts, vestes, pantalons, sacs, bijoux, accessoires…), tri (ventes, récents, prix ↑/↓), déjà postés
- 🚫 **Masquer** des items qui ne doivent plus apparaître

**Poster**
- Choisir le salon ou le **forum** (1 item = 1 post, tag de forum choisi automatiquement selon la catégorie)
- Poster des items choisis, ou 📤 **tout poster** (~45/min, sans spam)
- ⏰ **Drops automatiques** : une recherche postée toute seule à intervalle régulier, avec 🔔 ping de rôle, jamais deux fois le même item dans un salon
- 🧾 **Historique** des posts, avec lien vers le message et suppression en un clic
- ♻️ **Anti-doublon** réglable

**Données**
- 📚 **Catalogues** : ajout en masse de liens, 📡 sources Discord surveillées, boutiques Jadeship (⭐ Trusted / 💎 High Tier), meilleurs items d'une boutique, 🚫 bannir une boutique
- Indexation de **toutes les catégories** de chaque boutique, photos et **titres anglais** récupérés automatiquement, **suivi des prix**

**Piloter**
- 📊 **Stats** : clics par jour, par agent, items et salons qui convertissent le mieux (chaque bouton passe par `/go`, qui compte le clic puis redirige ; aucune donnée personnelle gardée)
- ⚙️ **Réglages** : devise (€, $, £, CA$, A$, CHF), langue des cartes (FR/EN), couleur, salon par défaut, anti-doublon, 🔄 salons de **conversion automatique** des liens
- 🏷️ **Agents** : BBDBuy / Kakobuy avec juste ton code (seul `AGENTS_OWNER_ID` peut les modifier)
- 👥 **Accès** · 🩺 **Santé** (indexeur, files, erreurs récentes)

## Installation Discord

1. Portail développeur → **New Application** ; copie l'Application ID et la Public Key dans `wrangler.toml`.
2. Onglet **Bot** → Reset Token → `npx wrangler secret put DISCORD_BOT_TOKEN` ; active **Message Content Intent** (sources et conversion automatique).
3. `npx wrangler deploy`, puis : `curl -X POST -H "Authorization: Bearer $(cat .secrets)" https://finds-bot.wheatenmoon5861.workers.dev/api/setup` (URL des interactions + commandes).
4. Invitation : `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=216064`
   (voir les salons, envoyer des messages, intégrer des liens, lire l'historique, mentionner les rôles des drops).

## Base de données

Nouvelle installation : `npm run db:init`. Le schéma complet est dans `schema.sql`.

## Limites

- Taobao et 1688 exigent une connexion : pas d'indexation de boutiques, mais les items populaires arrivent via Jadeship et tout lien se convertit avec `/convert`.
- Si Weidian ralentit ou demande une vérification, l'indexeur s'arrête (rien n'est contourné) et reprend au passage suivant.
- Quotas gratuits : Workers AI (~3 000 titres réécrits / jour ; la plupart des titres arrivent déjà en anglais), 50 requêtes externes par exécution du Worker.

## Tests

`npm test` (liens, catégories, découverte) · `npm run test:e2e` (Worker local + faux Discord + vraie indexation Weidian)
