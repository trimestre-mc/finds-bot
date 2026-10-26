// Mise en forme et envoi d'un item dans un salon (carte, boutons suivis, historique, anti-doublon).

import { discordApi } from './discord.js';
import { buildAgentLink } from './links.js';
import { COMPONENTS_V2, container, gallery, text, sep, row, link, escape } from './components.js';
import { fetchWeidianItem } from './weidian.js';
import { getConfig, getMoney, formatMoney, formatCny, refreshRates, ACCENTS, LANGS } from './config.js';
import { forumTagFor } from './categories.js';
import { qcButtons, refreshQc, communityQc, postForumQc } from './qc.js';

export const PLATFORM_NAMES = { weidian: 'Weidian', taobao: 'Taobao', '1688': '1688' };
export const FORUM = 15;
export const POST_INTERVAL_MS = 1100;
export const POSTS_PER_MINUTE = 45;
const MAX_CALLS = 40;

// Taux pour la devise choisie (objet { rate, code }), utilisé partout pour afficher et filtrer les prix.
export async function getRate(env) {
  return getMoney(env);
}

export const refreshRate = refreshRates;

export function formatPrice(cny, money) {
  if (cny == null) return '—';
  return `${formatCny(cny)} · ~${formatMoney(cny, money)}`;
}

export function itemTitle(item) {
  return (item.title_en || item.title_zh || `Item ${item.item_id}`).slice(0, 256);
}

export async function getAgents(env) {
  const { results } = await env.DB.prepare('SELECT * FROM agents ORDER BY position, name').all();
  return results;
}

// Tout ce qu'il faut pour poster : agents, devise, réglages, adresse publique (boutons suivis).
export async function postContext(env) {
  const cfg = await getConfig(env);
  const [agents, money] = await Promise.all([getAgents(env), getMoney(env, cfg)]);
  return { cfg, agents, money, base: (env.PUBLIC_URL || '').replace(/\/$/, ''), forumTags: new Map() };
}

// Photos d'un item : jusqu'à 4. Pour Weidian, on lit la page produit une fois puis on garde le résultat.
// Renvoie [photos, nombre de requêtes externes faites].
export async function itemImages(env, item, allowFetch = true) {
  let images = [];
  try { images = item.images ? JSON.parse(item.images) : []; } catch {}
  if (item.images == null && allowFetch && item.platform === 'weidian') {
    try {
      images = (await fetchWeidianItem(item.item_id)).images;
    } catch (err) {
      console.log('photos', item.id, String(err).slice(0, 120));
    }
    await env.DB.prepare('UPDATE items SET images = ? WHERE id = ?').bind(JSON.stringify(images.slice(0, 8)), item.id).run();
    return [mergeImages(item.image, images), 1];
  }
  return [mergeImages(item.image, images), 0];
}

function mergeImages(main, extra) {
  return [...new Set([main, ...(extra || [])].filter((u) => u && /^https:\/\//.test(u)))].slice(0, 4);
}

// Lien d'un bouton : passe par /go pour compter le clic (si l'adresse publique est connue), sinon lien direct.
export function trackedLink(ctx, item, agentName, direct, channelId) {
  if (!ctx.base) return direct;
  const c = channelId ? `?c=${channelId}` : '';
  return `${ctx.base}/go/${encodeURIComponent(item.id)}/${encodeURIComponent(agentName)}${c}`;
}

// Boutons d'une carte : agents + annonce d'origine, puis une ligne QC si des photos QC existent.
export function agentButtons(ctx, item, channelId, community = null) {
  const t = LANGS[ctx.cfg.lang];
  const platform = PLATFORM_NAMES[item.platform] || item.platform;
  const buttons = ctx.agents.slice(0, 14).map((a) => link(t.buy(a.name).slice(0, 80),
    trackedLink(ctx, item, a.name, buildAgentLink(a.template, item), channelId), '🛒'));
  buttons.push(link(t.view(platform).slice(0, 80), trackedLink(ctx, item, 'source', item.url, channelId), '🔗'));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
  // Le bouton QC rejoint la dernière ligne s'il reste de la place, sinon il a sa propre ligne.
  const qc = qcButtons(item, community, ctx.cfg.lang);
  const last = rows[rows.length - 1];
  if (last.components.length + qc.length <= 5) last.components.unshift(...qc);
  else rows.push(row(...qc));
  return rows;
}

// Carte d'un item posté dans un salon (Components V2).
export function buildItemMessage(item, ctx, images = [], channelId = null, community = null) {
  const t = LANGS[ctx.cfg.lang];
  const platform = PLATFORM_NAMES[item.platform] || item.platform;
  const dropped = item.prev_price && item.price_cny && item.prev_price > item.price_cny;
  const price = item.price_cny != null
    ? `### 💶 ${formatMoney(item.price_cny, ctx.money)}  ·  ${formatCny(item.price_cny)}` +
      (dropped ? `\n📉 ${t.drop(`~~${formatMoney(item.prev_price, ctx.money)}~~`)}` : '')
    : `### 💶 ${t.noPrice}`;
  const pics = images.length ? images : item.image ? [item.image] : [];
  const meta = [`🏪 ${escape(item.shop_name || platform)}`, platform];
  if (item.popularity) meta.push(`🔥 ${t.sold(item.popularity)}`);

  return {
    flags: COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [container([
      pics.length ? gallery(pics) : null,
      text(`## ${escape(itemTitle(item))}`),
      text(`${price}\n-# ${meta.join('  ·  ')}`),
      sep(),
      ...agentButtons(ctx, item, channelId, community),
    ], (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color)],
  };
}

// Déjà posté dans ce salon récemment ? (anti-doublon, durée réglable)
export async function recentlyPosted(env, itemId, channelId, days) {
  if (!days) return false;
  const row = await env.DB.prepare('SELECT 1 FROM posts WHERE item_id = ? AND channel_id = ? AND posted_at > ? LIMIT 1')
    .bind(itemId, channelId, Date.now() - days * 86400000).first();
  return !!row;
}

// Tags disponibles d'un forum (une requête par forum et par exécution).
async function forumTag(env, ctx, channelId, category) {
  if (!ctx.forumTags.has(channelId)) {
    const ch = await discordApi(env, 'GET', `/channels/${channelId}`).catch(() => null);
    ctx.forumTags.set(channelId, { tags: (ch && ch.available_tags) || [], required: !!(ch && ch.flags & (1 << 4)) });
  }
  const f = ctx.forumTags.get(channelId);
  const tag = forumTagFor(f.tags, category) || (f.required && f.tags[0] ? f.tags[0].id : null);
  return tag ? [tag] : [];
}

// Poste un item : message dans un salon texte, ou nouveau post (1 item = 1 post) dans un forum.
// Renvoie le nombre de requêtes externes faites (pour rester sous la limite Cloudflare).
// checkQc : vérifier les QC sur Jadeship avant de poster (items populaires, ou post choisi à la main).
export async function postItem(env, item, channelId, ctx, allowFetch = true, channelType = 0, checkQc = false) {
  const wantQc = allowFetch && !item.qc_checked_at && (checkQc || item.popularity > 0);
  const [[images, fetched], withQc] = await Promise.all([
    itemImages(env, item, allowFetch),
    wantQc ? refreshQc(env, item) : item,
  ]);
  item = withQc;
  let calls = 1 + fetched + (wantQc ? 1 : 0);
  const message = buildItemMessage(item, ctx, images, channelId, await communityQc(env, item.id));
  let messageId;
  let threadId = null;
  if (Number(channelType) === FORUM) {
    const before = ctx.forumTags.has(channelId);
    const appliedTags = await forumTag(env, ctx, channelId, item.category);
    if (!before) calls++;
    const price = item.price_cny != null ? `  ·  ${formatMoney(item.price_cny, ctx.money)}` : '';
    const name = `${itemTitle(item).slice(0, 100 - price.length)}${price}`;
    const thread = await discordApi(env, 'POST', `/channels/${channelId}/threads`, { name, message, applied_tags: appliedTags });
    threadId = thread && thread.id;
    messageId = threadId;
    // Sous le post : quelques photos QC de la communauté et le lien vers la galerie des agents.
    if (threadId && ctx.cfg.forumQc && allowFetch) {
      calls += await postForumQc(env, threadId, item, ctx.cfg.lang)
        .catch((err) => { console.log('qc forum', String(err).slice(0, 200)); return 1; });
    }
  } else {
    const msg = await discordApi(env, 'POST', `/channels/${channelId}/messages`, message);
    messageId = msg && msg.id;
  }
  // Le message est déjà sur Discord : si la base refuse l'écriture (quota du jour), on ne fait pas échouer le post.
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE items SET posted_count = posted_count + 1, last_posted = ? WHERE id = ?').bind(now, item.id),
    env.DB.prepare('INSERT INTO posts (item_id, channel_id, message_id, thread_id, posted_at) VALUES (?, ?, ?, ?, ?)')
      .bind(item.id, channelId, messageId || null, threadId, now),
  ]).catch((err) => console.log('historique', String(err).slice(0, 120)));
  return calls;
}

// Vide la file "tout poster" pendant budgetMs. Appelé par le cron et juste après « Confirmer ».
export async function processQueue(env, budgetMs) {
  // Un seul envoyeur à la fois (cron et bouton « Confirmer » peuvent se chevaucher).
  const now = Date.now();
  const lock = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('queue_lock', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) < ?
     RETURNING value`,
  ).bind(String(now + budgetMs + 15000), now).first();
  if (!lock) return 0;

  const deadline = now + budgetMs;
  let ctx = null;
  let posted = 0;
  let calls = 0; // Cloudflare gratuit : 50 requêtes externes max par exécution
  try {
    while (Date.now() < deadline && calls < MAX_CALLS) {
      const job = await env.DB.prepare(
        `DELETE FROM post_queue WHERE id = (SELECT MIN(id) FROM post_queue) RETURNING item_id, channel_id, channel_type, ping`,
      ).first();
      if (!job) break;
      if (!ctx) ctx = await postContext(env);
      const started = Date.now();
      try {
        if (job.ping) {
          // Message d'annonce d'un drop (ping de rôle), juste avant les items.
          await discordApi(env, 'POST', `/channels/${job.channel_id}/messages`, {
            content: job.ping, allowed_mentions: { parse: ['roles', 'everyone'] },
          });
          calls++;
        }
        const item = job.item_id && await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(job.item_id).first();
        if (!item) continue; // item supprimé entre-temps, ou simple annonce
        if (await recentlyPosted(env, item.id, job.channel_id, ctx.cfg.dedupeDays)) continue;
        calls += await postItem(env, item, job.channel_id, ctx, calls < MAX_CALLS - 3, job.channel_type);
        posted++;
      } catch (err) {
        console.log('envoi échoué', job.item_id, String(err).slice(0, 300));
        await logError(env, 'envoi', `${job.item_id} → <#${job.channel_id}> : ${String(err.message || err).slice(0, 200)}`);
        if (/-> (403|404)/.test(String(err))) {
          // Salon inaccessible : on vide le reste de la file pour ce salon.
          await env.DB.prepare('DELETE FROM post_queue WHERE channel_id = ?').bind(job.channel_id).run();
        }
      }
      // Discord accepte ~1 message par seconde et par salon pour un bot.
      const wait = POST_INTERVAL_MS - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  } finally {
    await env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'queue_lock'").run();
  }
  return posted;
}

// Journal des erreurs (écran 🩺 Santé), limité aux 200 dernières.
export async function logError(env, kind, message) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO logs (at, kind, message) VALUES (?, ?, ?)').bind(Date.now(), kind, String(message).slice(0, 300)),
    env.DB.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 200)'),
  ]).catch(() => {});
}
