// Mise en forme et envoi d'un item dans un salon.

import { discordApi } from './discord.js';
import { buildAgentLink } from './links.js';

import { COMPONENTS_V2, GOLD, container, gallery, text, sep, row, link, escape } from './components.js';

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

// Carte d'un item posté dans un salon (Components V2).
export function buildItemMessage(item, agents, rate) {
  const platform = PLATFORM_NAMES[item.platform] || item.platform;
  const buttons = agents.slice(0, 24).map((a) => link(`Acheter sur ${a.name}`.slice(0, 80), buildAgentLink(a.template, item), '🛒'));
  buttons.push(link(platform, item.url, '🔗'));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(row(...buttons.slice(i, i + 5)));

  const original = item.title_en && item.title_zh && item.title_en !== item.title_zh ? `\n-# ${escape(item.title_zh.slice(0, 150))}` : '';
  const price = item.price_cny != null
    ? `### ¥${Number(item.price_cny).toFixed(item.price_cny % 1 ? 2 : 0)}  ·  ~${(item.price_cny * rate).toFixed(2).replace('.', ',')} €`
    : '### Prix non indiqué';

  return {
    flags: COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [container([
      item.image ? gallery([item.image]) : null,
      text(`## ${escape(itemTitle(item))}${original}`),
      text(`${price}\n🏪 ${escape(item.shop_name || platform)}`),
      sep(),
      ...rows,
      text(`-# ${platform} · ${item.item_id}`),
    ], GOLD)],
  };
}

export async function postItem(env, item, channelId, agents, rate) {
  await discordApi(env, 'POST', `/channels/${channelId}/messages`, buildItemMessage(item, agents, rate));
  await env.DB.prepare('UPDATE items SET posted_count = posted_count + 1, last_posted = ? WHERE id = ?')
    .bind(Date.now(), item.id).run();
}

export const POST_INTERVAL_MS = 1100;
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
  try {
    while (Date.now() < deadline) {
      const job = await env.DB.prepare(
        `DELETE FROM post_queue WHERE id = (SELECT MIN(id) FROM post_queue) RETURNING item_id, channel_id`,
      ).first();
      if (!job) break;
      const item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(job.item_id).first();
      if (!item) continue; // item supprimé entre-temps
      if (!agents) [agents, rate] = await Promise.all([getAgents(env), getRate(env)]);
      const started = Date.now();
      try {
        await postItem(env, item, job.channel_id, agents, rate);
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
