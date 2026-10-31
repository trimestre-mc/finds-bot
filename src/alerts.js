// Alertes de prix : « 🔔 Suivre » sous un item. Toutes les 10 minutes, le bot revérifie le prix des items suivis
// (FinderQC, une requête par item, quelques items par passage) ; si le prix baisse, chaque membre qui le suit
// reçoit un message privé avec la carte de l'item. Un membre suit au plus MAX_PER_USER items.

import { COMPONENTS_V2, container, text, section, sep, thumb, escape } from './components.js';
import { discordApi } from './discord.js';
import { postContext, buildItemMessage, agentButtons } from './post.js';
import { itemById, itemDb, itemsWhereIds, itemDbs } from './shard.js';
import { formatMoney, formatCny, getMoney } from './config.js';
import { expandQuery, relevance } from './synonyms.js';
import { etxt, emo } from './emojis.js';
import { finderItem } from './livesearch.js';

const MAX_PER_USER = 50;
const ITEMS_PER_RUN = 10;
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
  const [{ results }, { results: searches }] = await Promise.all([
    env.DB.prepare('SELECT item_id, price FROM watches WHERE user_id = ? ORDER BY at DESC LIMIT 8').bind(userId).all(),
    env.DB.prepare('SELECT id, q, sent FROM search_alerts WHERE user_id = ? ORDER BY at DESC LIMIT 5').bind(userId).all(),
  ]);
  // Alertes de recherche : une ligne chacune, avec un bouton pour la supprimer.
  const searchBlocks = searches.length ? [
    text(`### ${e('fb_search')} Tes alertes de recherche`),
    ...searches.map((a) => section(`« **${escape(a.q)}** »\n-# ${a.sent ? `${a.sent} message${a.sent > 1 ? 's' : ''} envoyé${a.sent > 1 ? 's' : ''}` : 'en attente de nouveautés'}`,
      { type: 2, style: 4, label: 'Supprimer', custom_id: `pub:salertdel:${a.id}` })),
    sep(),
  ] : [];
  if (!results.length) {
    return [container([
      ...searchBlocks,
      text(`### ${e('fb_bell')} Tu ne suis aucun item\nClique sur 🔔 sous un item : je t'écris en privé dès que son prix baisse.` +
        (searches.length ? '' : `\n${e('fb_search')} Et sous les résultats de \`/find\`, « M'alerter des nouveautés » te prévient des nouveaux items.`)),
    ])];
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
    ...searchBlocks,
    text(`### ${e('fb_bell')} Tes alertes de prix\n-# ${total} item${total > 1 ? 's' : ''} suivi${total > 1 ? 's' : ''} · je t'écris en privé si un prix baisse.`),
    sep(),
    ...blocks,
  ])];
}

// ---------------------------------------------------------------- Alertes de recherche

// Un membre enregistre une recherche (bouton sous /find) ; à chaque passage, le bot lit une seule fois les items
// ajoutés depuis le passage précédent (par rowid, dans chaque base) et les compare à toutes les alertes. Les lectures
// ne dépendent donc que du nombre de nouveaux items, pas du nombre d'alertes.
const MAX_SEARCH_ALERTS = 10;
const NEW_ROWS_PER_RUN = 8000; // par base et par passage (toutes les 5 min)
const ITEMS_PER_DM = 5;
const DM_PER_RUN_ALERTS = 10;

const alertKey = (p) => JSON.stringify({ q: (p.q || '').trim().toLowerCase(), category: p.category || null, max: p.max ?? null });

// Clic sur « M'alerter » : crée l'alerte, ou la supprime si elle existe déjà. Renvoie le texte de la réponse.
export async function toggleSearchAlert(env, userId, guildId, params) {
  const ctx = await postContext(env);
  const e = (n) => etxt(ctx.emojis, n);
  const q = String(params.q || '').trim();
  if (!q) return `${e('fb_warn')} Il faut des mots-clés pour créer une alerte (ex : \`/find chrome hearts hoodie\`).`;
  const key = alertKey(params);
  const had = await env.DB.prepare('DELETE FROM search_alerts WHERE user_id = ? AND params = ? RETURNING id').bind(userId, key).first();
  if (had) return `${e('fb_bell')} Alerte « ${escape(q)} » supprimée.`;
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM search_alerts WHERE user_id = ?').bind(userId).first();
  if (n.n >= MAX_SEARCH_ALERTS) return `${e('fb_warn')} Tu as déjà ${MAX_SEARCH_ALERTS} alertes : supprimes-en une dans \`/suivis\`.`;
  // Seuls les items ajoutés après la création de l'alerte comptent.
  // Base illisible (quota du mois) : pas de repère pour elle, le passage périodique part de son propre curseur.
  const cursors = await Promise.all(itemDbs(env).map((db) => db.prepare('SELECT MAX(rowid) AS m FROM items').first().then((r) => r.m || 0).catch(() => null)));
  await env.DB.prepare('INSERT INTO search_alerts (user_id, guild_id, q, params, cursors, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, guildId || null, q.slice(0, 100), key, JSON.stringify(cursors), Date.now()).run();
  const price = params.max != null ? ` à ${params.max} ${ctx.money.code} max` : '';
  return `${e('fb_bell')} **Alerte créée !** Dès qu'un nouvel item « ${escape(q)} »${price} arrive dans le catalogue, je t'écris en privé.\n-# Tes alertes : \`/suivis\`. Re-clique sur le bouton pour l'arrêter.`;
}

export async function deleteSearchAlert(env, userId, id) {
  await env.DB.prepare('DELETE FROM search_alerts WHERE id = ? AND user_id = ?').bind(Number(id) || 0, userId).run();
}

// Passage périodique : nouveaux items de chaque base depuis le dernier passage, comparés à toutes les alertes.
export async function checkSearchAlerts(env) {
  const { results: alerts } = await env.DB.prepare('SELECT * FROM search_alerts').all();
  const dbs = itemDbs(env);
  const saved = await env.DB.prepare("SELECT value FROM settings WHERE key = 'salert:cursor'").first();
  let cursors = [];
  try { cursors = saved ? JSON.parse(saved.value) : []; } catch {}
  // Base illisible : son curseur ne bouge pas, les autres bases sont quand même parcourues.
  const tops = await Promise.all(dbs.map((db) => db.prepare('SELECT MAX(rowid) AS m FROM items').first().then((r) => r.m || 0).catch(() => null)));
  const next = tops.map((top, i) => (top == null ? (cursors[i] ?? null) : cursors[i] == null ? top : Math.min(top, cursors[i] + NEW_ROWS_PER_RUN)));
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('salert:cursor', ?)").bind(JSON.stringify(next)).run();
  if (!alerts.length) return 0;
  const parsed = alerts.map((a) => {
    const p = JSON.parse(a.params);
    let from = [];
    try { from = JSON.parse(a.cursors || '[]'); } catch {}
    return { ...a, p, groups: expandQuery(p.q), from };
  });
  const money = await getMoney(env);
  const byUser = new Map();
  for (const [i, db] of dbs.entries()) {
    if (cursors[i] == null || next[i] <= cursors[i]) continue;
    const rows = await db.prepare(
      `SELECT rowid AS _r, id, platform, item_id, url, title_en, title_zh, shop_name, category, price_cny, image, popularity, qc_count
       FROM items WHERE rowid > ? AND rowid <= ? AND hidden = 0`,
    ).bind(cursors[i], next[i]).all().then((r) => r.results).catch((err) => { console.log('alertes recherche : base sautée', String(err).slice(0, 100)); return []; });
    for (const a of parsed) {
      for (const r of rows) {
        if (r._r <= (a.from[i] || 0)) continue;
        if (a.p.category && r.category !== a.p.category) continue;
        if (a.p.max != null && !(r.price_cny != null && r.price_cny * money.rate <= a.p.max)) continue;
        if (relevance(a.groups, r) <= 0) continue;
        if (!byUser.has(a.user_id)) byUser.set(a.user_id, []);
        const list = byUser.get(a.user_id);
        if (!list.some((x) => x.item.id === r.id)) list.push({ alert: a, item: r });
      }
    }
  }
  let sent = 0;
  const ctx = byUser.size ? await postContext(env) : null;
  for (const [userId, matches] of byUser) {
    if (sent >= DM_PER_RUN_ALERTS) break;
    const top = matches.sort((x, y) => (y.item.popularity || 0) - (x.item.popularity || 0)).slice(0, ITEMS_PER_DM);
    const queries = [...new Set(top.map((m) => m.alert.q))].map((q) => `« ${escape(q)} »`).join(', ');
    const blocks = top.flatMap(({ item }) => {
      const meta = [formatMoney(item.price_cny || 0, ctx.money), item.popularity ? `${etxt(ctx.emojis, 'fb_fire')} ${item.popularity}` : null,
        item.qc_count ? `${etxt(ctx.emojis, 'fb_qc')} ${item.qc_count} QC` : null].filter(Boolean);
      const head = `**${escape(String(item.title_en || item.title_zh || item.id).slice(0, 80))}**\n${meta.join('  ·  ')}`;
      return [sep(), /^https:\/\//.test(item.image || '') ? section(head, thumb(item.image)) : text(head), agentButtons(ctx, item, null)[0]];
    });
    try {
      const dm = await discordApi(env, 'POST', '/users/@me/channels', { recipient_id: userId });
      await discordApi(env, 'POST', `/channels/${dm.id}/messages`, {
        flags: COMPONENTS_V2, allowed_mentions: { parse: [] },
        components: [container([
          text(`### ${etxt(ctx.emojis, 'fb_bell')} Nouveau pour ta recherche ${queries}\n-# ${matches.length} nouvel${matches.length > 1 ? 's' : ''} item${matches.length > 1 ? 's' : ''} depuis ma dernière vérification.`),
          ...blocks,
        ])],
      });
      sent++;
      await env.DB.prepare(`UPDATE search_alerts SET sent = sent + 1, checked_at = ? WHERE user_id = ?`).bind(Date.now(), userId).run();
    } catch (err) {
      console.log('alerte recherche (message privé)', userId, String(err).slice(0, 120));
    }
  }
  return sent;
}
