// Alertes de prix : « 🔔 Suivre » sous un item. Toutes les 30 minutes, le bot revérifie le prix des items suivis
// (FinderQC, une requête par item, quelques items par passage) ; si le prix baisse, chaque membre qui le suit
// reçoit un message privé avec la carte de l'item. Un membre suit au plus MAX_PER_USER items.

import { COMPONENTS_V2, container, text, section, sep, escape } from './components.js';
import { discordApi } from './discord.js';
import { postContext, buildItemMessage } from './post.js';
import { itemById, itemDb, itemsWhereIds } from './shard.js';
import { formatMoney, formatCny } from './config.js';
import { etxt, emo } from './emojis.js';
import { finderItem } from './livesearch.js';

const MAX_PER_USER = 50;
const ITEMS_PER_RUN = 8;
const DMS_PER_RUN = 8;
const UA = 'finds-bot/1.0 (+https://github.com/trimestre-mc/finds-bot)';

// Clic sur « Suivre » : suit l'item, ou arrête de le suivre. Renvoie le texte de la réponse privée.
export async function toggleWatch(env, userId, guildId, key) {
  const ctx = await postContext(env);
  const e = (n) => etxt(ctx.emojis, n);
  const had = await env.DB.prepare('DELETE FROM watches WHERE user_id = ? AND item_id = ? RETURNING item_id').bind(userId, key).first();
  if (had) return `${e('fb_bell')} Tu ne suis plus cet item.`;
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM watches WHERE user_id = ?').bind(userId).first();
  if (n.n >= MAX_PER_USER) return `${e('fb_warn')} Tu suis déjà ${MAX_PER_USER} items : arrête d'en suivre un (re-clique sur 🔔) pour en ajouter.`;
  const item = (await itemById(env, key)) || (await finderItem(key).catch(() => null));
  await env.DB.prepare('INSERT OR REPLACE INTO watches (user_id, item_id, price, guild_id, at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, key, item ? item.price_cny : null, guildId || null, Date.now()).run();
  const price = item && item.price_cny != null ? ` (prix actuel : **${formatMoney(item.price_cny, ctx.money)}** · ${formatCny(item.price_cny)})` : '';
  return `${e('fb_bell')} **Suivi !** Je t'envoie un message privé dès que le prix baisse${price}.\n-# Re-clique sur 🔔 pour arrêter. Pense à autoriser les messages privés des membres du serveur.`;
}

// Prix actuel d'un produit chez FinderQC (null si inconnu).
async function currentPrice(item) {
  const res = await fetch(`https://server.finderqc.com/api/spu/webSpuInfo?id=${encodeURIComponent(item.item_id)}&page=1&pageSize=1`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`FinderQC ${res.status}`);
  const data = await res.json();
  const s = data && data.code === 0 && data.data && data.data.spuInfo;
  return s && Number(s.cnPrice) > 0 ? Number(s.cnPrice) : null;
}

// Passage périodique : revérifie quelques items suivis (à tour de rôle) et prévient les membres en cas de baisse.
export async function checkWatches(env) {
  const cursor = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'watch:cursor'").first()) || { value: '' };
  let { results: keys } = await env.DB.prepare('SELECT DISTINCT item_id FROM watches WHERE item_id > ? ORDER BY item_id LIMIT ?')
    .bind(cursor.value, ITEMS_PER_RUN).all();
  if (!keys.length) {
    ({ results: keys } = await env.DB.prepare('SELECT DISTINCT item_id FROM watches ORDER BY item_id LIMIT ?').bind(ITEMS_PER_RUN).all());
  }
  if (!keys.length) return 0;
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('watch:cursor', ?)").bind(keys[keys.length - 1].item_id).run();
  // Items pas (encore) dans la base : leur fiche FinderQC, pour pouvoir quand même vérifier le prix et prévenir.
  const inBase = await itemsWhereIds(env, keys.map((k) => k.item_id));
  const missing = keys.map((k) => k.item_id).filter((k) => !inBase.some((i) => i.id === k));
  const items = [...inBase, ...(await Promise.all(missing.map((k) => finderItem(k).catch(() => null)))).filter(Boolean)];
  let ctx = null;
  let sent = 0;
  for (const item of items) {
    let price;
    try { price = await currentPrice(item); } catch (err) { console.log('alertes prix', String(err).slice(0, 100)); break; }
    if (price == null) continue;
    if (item.price_cny != null && price !== item.price_cny) {
      // Nouveau prix enregistré (avec l'ancien s'il a baissé : badge « baisse de prix » sur les cartes).
      await itemDb(env, item.id).prepare(
        `UPDATE items SET prev_price = CASE WHEN ? < price_cny THEN price_cny ELSE NULL END, price_changed_at = ?, price_cny = ? WHERE id = ?`,
      ).bind(price, Date.now(), price, item.id).run();
    }
    const { results: fans } = await env.DB.prepare('SELECT user_id, price FROM watches WHERE item_id = ? AND price IS NOT NULL AND price > ? * 1.01')
      .bind(item.id, price).all();
    for (const f of fans) {
      if (sent >= DMS_PER_RUN) break;
      ctx = ctx || await postContext(env);
      const card = buildItemMessage({ ...item, prev_price: f.price, price_cny: price }, ctx);
      const head = text(`### ${etxt(ctx.emojis, 'fb_drop')} Baisse de prix sur un item que tu suis\n` +
        `**${formatMoney(f.price, ctx.money)}** → **${formatMoney(price, ctx.money)}** (${formatCny(f.price)} → ${formatCny(price)})`);
      try {
        const dm = await discordApi(env, 'POST', '/users/@me/channels', { recipient_id: f.user_id });
        await discordApi(env, 'POST', `/channels/${dm.id}/messages`, {
          flags: COMPONENTS_V2, allowed_mentions: { parse: [] }, components: [container([head]), ...card.components],
        });
        sent++;
      } catch (err) {
        console.log('alerte prix (message privé)', f.user_id, String(err).slice(0, 120)); // messages privés fermés
      }
      await env.DB.prepare('UPDATE watches SET price = ?, notified_at = ? WHERE user_id = ? AND item_id = ?')
        .bind(price, Date.now(), f.user_id, item.id).run();
    }
  }
  return sent;
}

// /suivis : les items suivis par le membre (10 derniers), avec leur prix au moment du suivi et un bouton pour arrêter.
export async function watchesView(env, userId) {
  const ctx = await postContext(env);
  const e = (n) => etxt(ctx.emojis, n);
  const { results } = await env.DB.prepare('SELECT item_id, price FROM watches WHERE user_id = ? ORDER BY at DESC LIMIT 10').bind(userId).all();
  if (!results.length) {
    return [container([text(`### ${e('fb_bell')} Tu ne suis aucun item\nClique sur 🔔 sous un item : je t'écris en privé dès que son prix baisse.`)])];
  }
  const items = new Map((await itemsWhereIds(env, results.map((r) => r.item_id))).map((i) => [i.id, i]));
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM watches WHERE user_id = ?').bind(userId).first()).n;
  const blocks = results.map((r) => {
    const i = items.get(r.item_id) || { item_id: r.item_id.split(':')[1] };
    const now = i.price_cny != null ? formatMoney(i.price_cny, ctx.money) : '—';
    const was = r.price != null && i.price_cny != null && r.price > i.price_cny ? ` (au lieu de ${formatMoney(r.price, ctx.money)})` : '';
    return section(`**${escape(String(i.title_en || i.title_zh || r.item_id).slice(0, 70))}**\n${now}${was}`,
      { type: 2, style: 2, emoji: emo(ctx.emojis, 'fb_bell'), label: 'Ne plus suivre', custom_id: `pub:watch:${r.item_id}`.slice(0, 100) });
  });
  return [container([
    text(`### ${e('fb_bell')} Tes alertes de prix\n-# ${total} item${total > 1 ? 's' : ''} suivi${total > 1 ? 's' : ''} · je t'écris en privé si un prix baisse.`),
    sep(),
    ...blocks,
  ])];
}
