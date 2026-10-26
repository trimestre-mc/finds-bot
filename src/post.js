// Mise en forme et envoi d'un item dans un salon.

import { discordApi } from './discord.js';
import { buildAgentLink } from './links.js';

import { COMPONENTS_V2, container, gallery, text, sep, row, link, escape } from './components.js';
import { fetchWeidianItem } from './weidian.js';

const CARD_ACCENT = 0xf97316;

export const PLATFORM_NAMES = { weidian: 'Weidian', taobao: 'Taobao', '1688': '1688' };

export async function getRate(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cny_eur'").first();
  const rate = row ? parseFloat(row.value) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : 0.13;
}

export async function refreshRate(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cny_eur_at'").first();
  if (row && Date.now() - Number(row.value) < 6 * 3600 * 1000) return;
  const res = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json');
  if (!res.ok) return;
  const data = await res.json();
  const rate = data && data.cny && data.cny.eur;
  if (!rate) return;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cny_eur', ?)").bind(String(rate)),
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cny_eur_at', ?)").bind(String(Date.now())),
  ]);
}

export function formatPrice(cny, rate) {
  if (cny == null) return '—';
  const eur = (cny * rate).toFixed(2).replace('.', ',');
  return `¥${Number(cny).toFixed(cny % 1 ? 2 : 0)} · ~${eur} €`;
}

export function itemTitle(item) {
  return (item.title_en || item.title_zh || `Item ${item.item_id}`).slice(0, 256);
}

export async function getAgents(env) {
  const { results } = await env.DB.prepare('SELECT * FROM agents ORDER BY position, name').all();
  return results;
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

const fmtCny = (cny) => `¥${Number(cny).toFixed(cny % 1 ? 2 : 0)}`;
const fmtEur = (cny, rate) => `${(cny * rate).toFixed(2).replace('.', ',')} €`;

// Carte d'un item posté dans un salon (Components V2).
export function buildItemMessage(item, agents, rate, images = []) {
  const platform = PLATFORM_NAMES[item.platform] || item.platform;
  const links = agents.slice(0, 20).map((a) => ({ name: a.name, url: buildAgentLink(a.template, item) }));
  const [main, ...others] = links;

  const buttons = others.map((l) => link(l.name.slice(0, 80), l.url, '🛒'));
  buttons.push(link(`Voir l'annonce ${platform}`, item.url, '🔗'));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(row(...buttons.slice(i, i + 5)));

  const price = item.price_cny != null
    ? `### 💶 ${fmtEur(item.price_cny, rate)}  ·  ${fmtCny(item.price_cny)}`
    : '### 💶 Prix sur l\'annonce';
  const pics = images.length ? images : item.image ? [item.image] : [];

  return {
    flags: COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [container([
      pics.length ? gallery(pics) : null,
      text(`## ${escape(itemTitle(item))}`),
      text(`${price}\n-# 🏪 ${escape(item.shop_name || platform)}  ·  ${platform}`),
      sep(),
      main ? text(`### [🛒 Acheter sur ${escape(main.name)} →](${main.url})`) : null,
      ...rows,
      text(`-# Prix indicatif, hors livraison  ·  ID ${item.item_id}`),
    ], CARD_ACCENT)],
  };
}

// Poste un item. Renvoie le nombre de requêtes externes faites (pour rester sous la limite Cloudflare).
export async function postItem(env, item, channelId, agents, rate, allowFetch = true) {
  const [images, fetched] = await itemImages(env, item, allowFetch);
  await discordApi(env, 'POST', `/channels/${channelId}/messages`, buildItemMessage(item, agents, rate, images));
  await env.DB.prepare('UPDATE items SET posted_count = posted_count + 1, last_posted = ? WHERE id = ?')
    .bind(Date.now(), item.id).run();
  return 1 + fetched;
}

export const POST_INTERVAL_MS = 1100;
const MAX_CALLS = 42;
export const POSTS_PER_MINUTE = 45;

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
  let agents = null;
  let rate = null;
  let posted = 0;
  let calls = 0; // Cloudflare gratuit : 50 requêtes externes max par exécution
  try {
    while (Date.now() < deadline && calls < MAX_CALLS) {
      const job = await env.DB.prepare(
        `DELETE FROM post_queue WHERE id = (SELECT MIN(id) FROM post_queue) RETURNING item_id, channel_id`,
      ).first();
      if (!job) break;
      const item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(job.item_id).first();
      if (!item) continue; // item supprimé entre-temps
      if (!agents) [agents, rate] = await Promise.all([getAgents(env), getRate(env)]);
      const started = Date.now();
      try {
        calls += await postItem(env, item, job.channel_id, agents, rate, calls < MAX_CALLS - 2);
        posted++;
      } catch (err) {
        console.log('envoi échoué', item.id, String(err).slice(0, 300));
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
