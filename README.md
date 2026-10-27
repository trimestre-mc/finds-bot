# finds-bot

Bot Discord de finds : il indexe des centaines de milliers d'items Weidian, Taobao et 1688, les traduit, les classe,
montre leurs QC dans Discord et les poste en belles cartes avec tes liens d'affiliation. 100 % gratuit.

- **Bot** : Cloudflare Worker (gratuit, 24 h/24) — `https://finds-bot.wheatenmoon5861.workers.dev`
- **Base** : deux bases Turso gratuites (Weidian dans la 1re, Taobao + 1688 dans la 2e, voir `src/shard.js`), D1 en secours
- **IA** : Workers AI (titres en anglais, lecture des marques sur les photos)
- **Indexeur** : GitHub Actions, 12 jobs en parallèle, lancés par le bot dès qu'il y a du travail ; synchro du catalogue FinderQC chaque minute
- **Emojis** : 32 emojis d'application dessinés pour le bot (`emojis/make.py`, envoyés avec `emojis/upload.py`), utilisables dans tous les serveurs

## Commandes

| Commande | Pour qui | Rôle |
|---|---|---|
| `/menu` | admins + membres ajoutés | Panneau complet (tout en boutons) |
| `/find recherche: categorie: prix_max:` | tout le monde | Chercher un item et l'acheter avec le bon lien |
| `/convert lien:` | tout le monde | Transformer n'importe quel lien Weidian / Taobao / 1688 / d'agent en boutons d'achat avec ton code |
| `/qc lien:` | tout le monde | Photos QC d'un item, dans Discord (ou celles d'un article qui ressemble) |
| `/coupon` | tout le monde | Tes coupons et liens d'inscription (message public, réglé dans 🏷️ Agents) |
| `/aide` | tout le monde | Guide « comment acheter » en 5 étapes, avec tes liens d'inscription |
| `/suivis` | tout le monde | Les alertes de prix du membre (bouton 🔔 sous les items) |

**Sous chaque item** : Acheter (badge de l'agent) · **QC** · **Comparer** (le même article chez d'autres vendeurs : le moins
cher, le plus vendu, le plus de QC) · lien d'origine · 🔔 **alerte de prix** (message privé si le prix baisse) · S'inscrire.
**Dans la fenêtre QC** : votes **GL / RL** (le score apparaît sur la carte dès 3 votes) et **Partager dans le salon**.
**Recherche** : synonymes, fautes de frappe, mots chinois, numéros collés (aj4, nb550) et recherche en direct dans tout
le catalogue FinderQC. **Salon de recherche par image** : la marque est lue sur la photo (Llama 4 Scout), puis 4 items.

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
- 🏷️ **Agents** : BBDBuy / Kakobuy avec juste ton code, bouton **S'inscrire** (lien, texte, emoji, couleur) et message
  de `/coupon` (seul `AGENTS_OWNER_ID` peut les modifier)
- 📌 **Poster le guide** / 🎁 **Poster /coupon** dans un salon, à épingler
- 🏆 **Top de la semaine** (⚙️ Réglages) : chaque lundi, les 5 items les plus cliqués, postés dans le salon choisi
- 📬 **Rapport du jour** en message privé au propriétaire (`AGENTS_OWNER_ID`) vers 21 h : clics, posts, alertes,
  items ajoutés par base, quotas, erreurs ; aperçu : `GET /api/report`
- 🩺 **Santé** : lectures et écritures du mois de chaque base, neurons d'IA du jour
- 👥 **Accès** · 🩺 **Santé** (indexeur, files, erreurs récentes)

## Sources de données et autorisations

| Source | Utilisation | Autorisation |
|---|---|---|
| Weidian (pages publiques) | Liste des boutiques, pages produit (photos, titres) | Pages publiques, rythme lent, arrêt dès le moindre refus |
| Jadeship | Best Items, Live Feed, annuaire des vendeurs | Accord du propriétaire, déclaré par l'utilisateur du bot le 26/10/2026 |
| FinderQC / UUFinds (même propriétaire) | Photos QC des agents (API `server.finderqc.com`) | Accord du propriétaire, déclaré par l'utilisateur du bot le 26/10/2026 |
| Repfind | Photos QC de secours (API `repfind.ai/client`) | Accord du propriétaire, déclaré par l'utilisateur du bot le 26/10/2026 |
| Discord (salons choisis) | Sources de finds, QC de la communauté, conversion des liens | Salons du serveur, choisis par les admins |

Ces accords n'ont pas été vérifiés par écrit dans ce dépôt : si l'un d'eux est retiré, désactiver la source correspondante
(`indexer/jadeship.mjs`, `fetchQcPage` / `fetchRepfindPage` dans `src/qc.js`). Le bot s'identifie toujours avec
`User-Agent: finds-bot/1.0 (+https://github.com/trimestre-mc/finds-bot)`, garde les résultats en cache et respecte les
limites de rythme ; aucune protection (Cloudflare, captcha, en-têtes) n'est contournée.

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
- Workers AI gratuit : 10 000 neurons / jour, comptés en coût réel (`ai_neurons`) : ~12 000 titres traduits par jour
  (0,63 neuron par titre) et la lecture des photos postées. 50 requêtes externes par exécution du Worker.
- Turso gratuit, par base : 10 M lignes écrites et 500 M lues par mois. Budgets d'écriture lissés jour par jour
  (`src/budget.js`), compteur de lectures du mois (`reads:month`) qui coupe le travail de fond à `READS_MONTH_CAP`.
  Jamais de `COUNT(*)` ni de tri complet de la table des items dans un passage automatique (le Worker signale toute
  requête qui lit plus de 20 000 lignes : « lecture lourde » dans les logs). Diagnostic : `GET /api/db-stats`.
- QC : une photo QC n'existe que si l'item a été acheté via un agent. Les items jamais achetés n'en ont nulle part ; le salon QC de la communauté comble ce vide.

## Tests

`npm test` (38 tests : recherche, deux bases, budgets, alertes, votes, comparateur, recherche par image…) ·
`npm run test:e2e` (Worker local + faux Discord + vraie indexation Weidian ; recherche en direct coupée avec `LIVE_SEARCH=0`)
