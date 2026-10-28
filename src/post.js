// Mise en forme et envoi d'un item dans un salon (carte, boutons suivis, historique, anti-doublon).

import { discordApi } from './discord.js';
import { buildAgentLink } from './links.js';
import { COMPONENTS_V2, container, gallery, text, sep, row, link, escape, Style } from './components.js';
import { fetchWeidianItem } from './weidian.js';
import { getConfig, getMoney, getSignup, formatMoney, formatCny, refreshRates, ACCENTS, LANGS, SIGNUP_COLORS, DEFAULTS } from './config.js';
import { forumTagFor, CATEGORY_BY_KEY } from './categories.js';
import { qcButtons, refreshQc, communityQc, postForumQc } from './qc.js';
import { itemDb, itemsWhereIds, batchByDb } from './shard.js';
import { loadEmojis, emo, etxt, AGENT_EMOJI, PLATFORM_EMOJI } from './emojis.js';
import { logEvent, kvGet, kvSet } from './kvstore.js';
import { cleanTitle } from './titles.js';

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
let ctxSaved = 0;

// La base illisible (quota du jour de D1 atteint) : dernière copie gardée dans Upstash, sinon les valeurs par défaut.
export async function postContext(env) {
  const base = (env.PUBLIC_URL || '').replace(/\/$/, '');
  try {
    const cfg = await getConfig(env);
    const [agents, money, signup, emojis] = await Promise.all([getAgents(env), getMoney(env, cfg), getSignup(env), loadEmojis(env)]);
    // Copie de secours au plus toutes les 10 min (chaque écriture compte dans le quota mensuel d'Upstash).
    if (Date.now() - ctxSaved > 600000) { ctxSaved = Date.now(); kvSet(env, 'ctx:cache', JSON.stringify({ cfg, agents, money, signup })).catch(() => {}); }
    return { cfg, agents, money, signup, emojis, base, forumTags: new Map() };
  } catch (err) {
    console.log('contexte (base illisible)', String(err).slice(0, 120));
    let kept = null;
    try { kept = JSON.parse(await kvGet(env, 'ctx:cache') || 'null'); } catch {}
    const emojis = await loadEmojis(env).catch(() => ({}));
    return { cfg: (kept && kept.cfg) || { ...DEFAULTS }, agents: (kept && kept.agents) || [], money: (kept && kept.money) || { rate: 0.13, code: 'eur' },
      signup: (kept && kept.signup) || null, emojis, base, forumTags: new Map() };
  }
}

// Bouton « S'inscrire » configuré par le propriétaire : lien suivi si gris, sinon bouton coloré (fenêtre avec le lien).
export function signupButton(ctx, item, channelId) {
  const s = ctx.signup;
  if (!s) return null;
  const color = SIGNUP_COLORS[s.color] || SIGNUP_COLORS.vert;
  const label = (s.label || 'S\'inscrire').slice(0, 80);
  const emoji = s.emoji && s.emoji !== '✍️' ? { name: s.emoji } : emo(ctx.emojis, 'fb_signup');
  if (color.style === Style.LINK) {
    const b = link(label, item ? trackedLink(ctx, item, 'signup', s.url, channelId) : s.url);
    if (emoji) b.emoji = emoji;
    return b;
  }
  return { type: 2, style: color.style, label, emoji, custom_id: `pub:su:${item ? item.id : ''}`.slice(0, 100) };
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
    await itemDb(env, item.id).prepare('UPDATE items SET images = ? WHERE id = ?').bind(JSON.stringify(images.slice(0, 8)), item.id).run();
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

// Boutons d'une carte, dans l'ordre d'importance : acheter (un bouton par agent), QC, annonce d'origine, puis
// l'inscription si elle est configurée. Lignes de 5 boutons au plus.
export function agentButtons(ctx, item, channelId, community = null) {
  const t = LANGS[ctx.cfg.lang];
  const platform = PLATFORM_NAMES[item.platform] || item.platform;
  const agents = ctx.agents.slice(0, 12);
  // Un seul agent : « Acheter sur BBDBuy » ; plusieurs : juste leur nom, plus lisible côte à côte.
  // Emojis du bot : badge de l'agent (BBDBuy, Kakobuy) ou chariot, badge de la plateforme (voir emojis.js).
  const buys = agents.map((a) => ({
    ...link((agents.length > 1 ? a.name : t.buy(a.name)).slice(0, 80), trackedLink(ctx, item, a.name, buildAgentLink(a.template, item), channelId)),
    emoji: emo(ctx.emojis, AGENT_EMOJI[a.preset] || AGENT_EMOJI[String(a.name).toLowerCase()] || 'fb_cart'),
  }));
  const buttons = [
    ...buys,
    ...qcButtons(item, community, ctx.cfg.lang, ctx.emojis),
    // Comparateur de vendeurs (même article ailleurs) : il lui faut la photo de l'item.
    /^https:\/\//.test(item.image || '') ? { type: 2, style: 2, label: ctx.cfg.lang === 'en' ? 'Compare' : 'Comparer',
      emoji: emo(ctx.emojis, 'fb_compare'), custom_id: `pub:cmp:${item.id}`.slice(0, 100) } : null,
    { ...link(platform, trackedLink(ctx, item, 'source', item.url, channelId)), emoji: emo(ctx.emojis, PLATFORM_EMOJI[item.platform] || 'fb_link') },
    // Alerte de prix (message privé si le prix baisse), voir alerts.js.
    { type: 2, style: 2, emoji: emo(ctx.emojis, 'fb_bell'), custom_id: `pub:watch:${item.id}`.slice(0, 100) },
    signupButton(ctx, item, channelId),
  ].filter(Boolean);
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
  return rows;
}

const nf = (n) => Number(n || 0).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ');

// Titre lisible : sans les mots de vendeur inutiles en tête, coupé proprement.
export function cardTitle(item, max = 100) {
  return cleanTitle(itemTitle(item), max);
}

// Carte d'un item posté dans un salon (Components V2) : photos, titre, prix, puis les infos utiles en une ligne.
export function buildItemMessage(item, ctx, images = [], channelId = null, community = null) {
  const t = LANGS[ctx.cfg.lang];
  const en = ctx.cfg.lang === 'en';
  const platform = PLATFORM_NAMES[item.platform] || item.platform;
  const dropped = item.prev_price && item.price_cny && item.prev_price > item.price_cny;
  const price = item.price_cny != null
    ? `## ${etxt(ctx.emojis, 'fb_price')} ${formatMoney(item.price_cny, ctx.money)}  ·  ${formatCny(item.price_cny)}` +
      (dropped ? `\n${etxt(ctx.emojis, 'fb_drop')} ${t.drop(`~~${formatMoney(item.prev_price, ctx.money)}~~`)}` : '')
    : `## ${etxt(ctx.emojis, 'fb_price')} ${t.noPrice}`;
  const pics = images.length ? images : item.image ? [item.image] : [];
  const cat = CATEGORY_BY_KEY[item.category];
  const qc = (item.qc_count || 0) + (community ? community.images : 0);
  const e = (n) => etxt(ctx.emojis, n);
  const meta = [
    item.popularity ? `${e('fb_fire')} ${t.sold(nf(item.popularity))}` : null,
    qc ? `${e('fb_qc')} ${nf(qc)} ${en ? 'QC photos' : 'photos QC'}` : null,
    // Avis des membres sur les QC (à partir de 3 votes).
    (item.gl_votes || 0) + (item.rl_votes || 0) >= 3
      ? `${e('fb_gl')} ${Math.round((100 * item.gl_votes) / (item.gl_votes + item.rl_votes))} % GL` : null,
    cat ? `${cat.emoji} ${en ? cat.en : cat.label}` : null,
    `${e('fb_shop')} ${escape((item.shop_name || platform).slice(0, 40))}`,
  ].filter(Boolean);
  // Badges : nouveauté (vue il y a moins de 2 jours), best-seller (1 000 ventes ou plus), beaucoup de QC.
  const badges = [
    item.first_seen && Date.now() - item.first_seen < 2 * 86400000 ? e('fb_new') : null,
    item.popularity >= 1000 ? e('fb_crown') : null,
    qc >= 100 ? e('fb_verified') : null,
  ].filter(Boolean).join(' ');

  return {
    flags: COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [container([
      pics.length ? gallery(pics) : null,
      text(`### ${badges ? `${badges} ` : ''}${escape(cardTitle(item))}`),
      text(`${price}\n-# ${meta.join('  ·  ')}`),
      sep(),
      ...agentButtons(ctx, item, channelId, community),
    ], (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color)],
  };
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
// opts.community : QC de la communauté déjà chargées (envoi groupé) ; opts.history : tableau où ajouter les
// écritures d'historique au lieu de les exécuter tout de suite (un seul lot à la fin).
export async function postItem(env, item, channelId, ctx, allowFetch = true, channelType = 0, checkQc = false, opts = {}) {
  const wantQc = allowFetch && !item.qc_checked_at && (checkQc || item.popularity > 0);
  const [[images, fetched], withQc] = await Promise.all([
    itemImages(env, item, allowFetch),
    wantQc ? refreshQc(env, item) : item,
  ]);
  item = withQc;
  let calls = 1 + fetched + (wantQc ? 1 : 0);
  const community = opts.community !== undefined ? opts.community : await communityQc(env, item.id);
  const message = buildItemMessage(item, ctx, images, channelId, community);
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
  // Paires [base, requête] : l'item dans sa base (voir shard.js), le post dans la 1re.
  const db = itemDb(env, item.id);
  const history = [
    [db, db.prepare('UPDATE items SET posted_count = posted_count + 1, last_posted = ? WHERE id = ?').bind(now, item.id)],
    [env.DB, env.DB.prepare('INSERT INTO posts (item_id, channel_id, message_id, thread_id, posted_at) VALUES (?, ?, ?, ?, ?)')
      .bind(item.id, channelId, messageId || null, threadId, now)],
  ];
  if (opts.history) opts.history.push(...history);
  else await batchByDb(history).catch((err) => console.log('historique', String(err).slice(0, 120)));
  return calls;
}

// QC de la communauté de plusieurs items en une requête : Map id → { posts, images, jump }.
async function communityQcMany(env, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const { results } = await env.DB.prepare(
    `SELECT item_id, guild_id, channel_id, message_id, images FROM qc_posts WHERE item_id IN (${ids.map(() => '?').join(',')}) ORDER BY at DESC`,
  ).bind(...ids).all();
  for (const q of results) {
    const c = map.get(q.item_id) || { posts: 0, images: 0, jump: `https://discord.com/channels/${q.guild_id}/${q.channel_id}/${q.message_id}` };
    c.posts++;
    c.images += q.images;
    map.set(q.item_id, c);
  }
  return map;
}

// Vide la file "tout poster" pendant budgetMs. Appelé par son cron (chaque minute) et juste après « Confirmer ».
// Envoi groupé : 10 items réservés, chargés et vérifiés en quelques requêtes, historique écrit en un seul lot.
// Avec Turso, chaque requête à la base compte dans les 50 requêtes externes autorisées par exécution.
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
  let external = 0; // requêtes Discord, Weidian, QC
  const used = () => external + (env.DB.calls || 0);
  try {
    while (Date.now() < deadline && used() < MAX_CALLS - 6) {
      const room = Math.max(1, Math.min(10, MAX_CALLS - used() - 6));
      const { results: jobs } = await env.DB.prepare(
        `DELETE FROM post_queue WHERE id IN (SELECT id FROM post_queue ORDER BY id LIMIT ?)
         RETURNING id, item_id, channel_id, channel_type, ping`,
      ).bind(room).all();
      if (!jobs.length) break;
      jobs.sort((a, b) => a.id - b.id);
      if (!ctx) ctx = await postContext(env);

      const ids = [...new Set(jobs.map((j) => j.item_id).filter(Boolean))];
      const marks = ids.map(() => '?').join(',');
      const [items, recent, community] = await Promise.all([
        itemsWhereIds(env, ids).then((results) => ({ results })),
        ids.length && ctx.cfg.dedupeDays
          ? env.DB.prepare(`SELECT item_id, channel_id FROM posts WHERE posted_at > ? AND item_id IN (${marks})`)
            .bind(Date.now() - ctx.cfg.dedupeDays * 86400000, ...ids).all()
          : { results: [] },
        communityQcMany(env, ids),
      ]);
      const byId = new Map(items.results.map((i) => [i.id, i]));
      const already = new Set(recent.results.map((r) => `${r.item_id}|${r.channel_id}`));
      const history = [];
      const deadChannels = new Set();

      for (const job of jobs) {
        if (deadChannels.has(job.channel_id)) continue;
        const started = Date.now();
        try {
          if (job.ping) {
            // Message d'annonce d'un drop (ping de rôle), juste avant les items.
            await discordApi(env, 'POST', `/channels/${job.channel_id}/messages`, {
              content: job.ping, allowed_mentions: { parse: ['roles', 'everyone'] },
            });
            external++;
          }
          const item = byId.get(job.item_id);
          if (!item || already.has(`${item.id}|${job.channel_id}`)) continue; // supprimé, simple annonce, ou déjà posté
          external += await postItem(env, item, job.channel_id, ctx, used() < MAX_CALLS - 8, job.channel_type, false,
            { community: community.get(item.id) || null, history });
          already.add(`${item.id}|${job.channel_id}`);
          posted++;
        } catch (err) {
          console.log('envoi échoué', job.item_id, String(err).slice(0, 300));
          if (/-> (403|404)/.test(String(err))) deadChannels.add(job.channel_id);
        }
        // Discord accepte ~1 message par seconde et par salon pour un bot.
        const wait = POST_INTERVAL_MS - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }

      // Historique en un seul lot ; salons inaccessibles : on vide le reste de leur file.
      for (const ch of deadChannels) {
        history.push([env.DB, env.DB.prepare('DELETE FROM post_queue WHERE channel_id = ?').bind(ch)]);
        // Salon supprimé ou interdit : ses drops sont mis en pause (sinon ils remplissent la file pour rien).
        history.push([env.DB, env.DB.prepare('UPDATE schedules SET enabled = 0 WHERE channel_id = ?').bind(ch)]);
        history.push([env.DB, env.DB.prepare('INSERT INTO logs (at, kind, message) VALUES (?, ?, ?)')
          .bind(Date.now(), 'envoi', `Le bot ne peut pas écrire dans <#${ch}> : file vidée et drops de ce salon en pause`)]);
      }
      if (history.length) await batchByDb(history).catch((err) => console.log('historique', String(err).slice(0, 120)));
    }
  } finally {
    await env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'queue_lock'").run();
  }
  return posted;
}

// Journal des erreurs (écran 🩺 Santé), limité aux 200 dernières.
export async function logError(env, kind, message) {
  await logEvent(env, 'error', `${kind} : ${String(message).slice(0, 140)}`).catch(() => {});
  await env.DB.batch([
    env.DB.prepare('INSERT INTO logs (at, kind, message) VALUES (?, ?, ?)').bind(Date.now(), kind, String(message).slice(0, 300)),
    env.DB.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 200)'),
  ]).catch(() => {});
}
