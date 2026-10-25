// Mise en forme et envoi d'un item dans un salon.

import { discordApi } from './discord.js';
import { buildAgentLink } from './links.js';

const PLATFORM_NAMES = { weidian: 'Weidian', taobao: 'Taobao', '1688': '1688' };
const LINK_BUTTON = 5;

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

export function buildItemMessage(item, agents, rate) {
  const platform = PLATFORM_NAMES[item.platform] || item.platform;
  const links = agents.slice(0, 24).map((a) => ({ label: a.name, url: buildAgentLink(a.template, item) }));
  const embed = {
    title: itemTitle(item),
    url: links.length ? links[0].url : item.url,
    color: 0xff4d4d,
    fields: [
      { name: '💰 Prix', value: formatPrice(item.price_cny, rate), inline: true },
      { name: '🏪 Vendeur', value: (item.shop_name || '—').slice(0, 100), inline: true },
    ],
    footer: { text: `${platform} · ${item.item_id}` },
  };
  if (item.title_en && item.title_zh && item.title_en !== item.title_zh) {
    embed.description = item.title_zh.slice(0, 200);
  }
  if (item.image) embed.image = { url: item.image };

  const buttons = links.map((l) => ({ type: 2, style: LINK_BUTTON, label: `Acheter sur ${l.label}`.slice(0, 80), url: l.url }));
  buttons.push({ type: 2, style: LINK_BUTTON, label: `Voir sur ${platform}`, url: item.url });
  const components = [];
  for (let i = 0; i < buttons.length; i += 5) components.push({ type: 1, components: buttons.slice(i, i + 5) });

  return { embeds: [embed], components };
}

export async function postItem(env, item, channelId, agents, rate) {
  await discordApi(env, 'POST', `/channels/${channelId}/messages`, buildItemMessage(item, agents, rate));
  await env.DB.prepare('UPDATE items SET posted_count = posted_count + 1, last_posted = ? WHERE id = ?')
    .bind(Date.now(), item.id).run();
}

// Vide une partie de la file "tout poster". Appelé chaque minute par le cron.
export async function processQueue(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT q.id AS qid, q.channel_id, i.* FROM post_queue q
     LEFT JOIN items i ON i.id = q.item_id ORDER BY q.id LIMIT ?`,
  ).bind(limit).all();
  if (!results.length) return 0;
  const agents = await getAgents(env);
  const rate = await getRate(env);
  let posted = 0;
  for (const row of results) {
    await env.DB.prepare('DELETE FROM post_queue WHERE id = ?').bind(row.qid).run();
    if (!row.id) continue; // item supprimé entre-temps
    try {
      await postItem(env, row, row.channel_id, agents, rate);
      posted++;
      await new Promise((r) => setTimeout(r, 1200));
    } catch (err) {
      console.log('envoi échoué', row.id, String(err).slice(0, 300));
      if (/-> (403|404)/.test(String(err))) {
        // Salon inaccessible : on vide le reste de la file pour ce salon.
        await env.DB.prepare('DELETE FROM post_queue WHERE channel_id = ?').bind(row.channel_id).run();
        break;
      }
    }
  }
  return posted;
}
