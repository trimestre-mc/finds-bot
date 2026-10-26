# finds-bot

Bot Discord qui indexe automatiquement des boutiques Weidian, permet de chercher dans les items et de les poster avec tes liens d'affiliation d'agents.

- **Bot** : Cloudflare Worker (gratuit, 24h/24) — `https://finds-bot.wheatenmoon5861.workers.dev`
- **Base** : Cloudflare D1
- **Traduction des titres** : Workers AI (chinois → anglais)
- **Indexeur** : GitHub Actions toutes les 10 min (Chromium sans fenêtre, ouvre les boutiques comme un visiteur)

## Utilisation

Une seule commande : **`/menu`**. Elle ouvre un panneau privé (visible par toi seul), et tout se fait avec des boutons, des menus et des formulaires :

| Bouton | Rôle |
|---|---|
| 🔎 **Rechercher** | Mots-clés et prix, puis : choisir le salon, poster les items sélectionnés ou 📤 tout poster (~45/min, démarre tout de suite) |
| ✨ **Nouveautés** | Les derniers items indexés |
| 📚 **Catalogues** | Ajouter une boutique Weidian, voir ses items, réindexer, retirer |
| 🏷️ **Agents** | Tes liens d'affiliation (un bouton « Acheter sur … » par agent sous chaque item) |
| ➕ **Ajouter un item** | À la main (Taobao, 1688, ou Weidian rempli tout seul) |
| 👥 **Accès** | Donner l'accès à d'autres membres |

Accès : le propriétaire et les membres avec la permission **Administrateur**, plus les membres ajoutés dans 👥 Accès.

Agents : choisis BBDBuy ou Kakobuy et colle juste ton code. « Autre agent » accepte un lien complet avec `{url}` (lien produit encodé), `{url_raw}`, `{id}`, `{platform}` ou `{PLATFORM}`. Seul `AGENTS_OWNER_ID` peut modifier les agents.

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

Par défaut, un nouveau catalogue est indexé au prochain passage (10 à 20 min, GitHub retarde parfois). Pour lancer l'indexeur tout de suite, crée un token GitHub *fine-grained* limité à ce repo avec la permission **Actions: write**, puis :
`npx wrangler secret put GITHUB_TOKEN` et décommente `GITHUB_REPO` dans `wrangler.toml`.

## Limites

- Taobao et 1688 exigent une connexion : pas d'indexation automatique, seulement ➕ Ajouter un item.
- Si Weidian demande une vérification, l'indexeur s'arrête (rien n'est contourné) et réessaie au passage suivant.
- Traduction : ~40 titres/min (quota gratuit Workers AI). Les items sont cherchables en chinois en attendant.

## Tests

`npm test` (liens) · `npm run test:e2e` (Worker local + faux Discord + vraie indexation Weidian)
