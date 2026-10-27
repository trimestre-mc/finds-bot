// Emojis personnalisés du bot : « emojis d'application » Discord (envoyés une fois sur l'application, utilisables
// par le bot dans tous les serveurs où il est, sans permission ni place dans les serveurs). Dessins : emojis/make.py.
// Leurs identifiants sont gardés dans les réglages ; sans eux, l'emoji Unicode de secours est utilisé.

import { discordApi } from './discord.js';

// Emoji de secours (Unicode) de chaque emoji du bot.
export const FALLBACK = {
  fb_qc: '📸', fb_gl: '✅', fb_rl: '❌', fb_photos: '🖼️', fb_verified: '✅', fb_cart: '🛒', fb_bbdbuy: '🛒', fb_kakobuy: '🛒',
  fb_weidian: '🔗', fb_taobao: '🔗', fb_1688: '🔗', fb_link: '🔗', fb_shop: '🏪', fb_price: '🏷️', fb_drop: '📉', fb_fire: '🔥',
  fb_crown: '👑', fb_star: '⭐', fb_new: '🆕', fb_search: '🔎', fb_compare: '⚖️', fb_coupon: '🎟️', fb_gift: '🎁',
  fb_signup: '✍️', fb_stats: '📊', fb_bell: '🔔', fb_box: '📦', fb_trend: '📈', fb_bot: '🤖', fb_warn: '⚠️', fb_live: '🟢',
  fb_loading: '⏳',
};

// Emoji d'un agent ou d'une plateforme (badge dédié s'il existe, sinon le chariot).
export const AGENT_EMOJI = { bbdbuy: 'fb_bbdbuy', kakobuy: 'fb_kakobuy' };
export const PLATFORM_EMOJI = { weidian: 'fb_weidian', taobao: 'fb_taobao', 1688: 'fb_1688' };

export async function loadEmojis(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'emojis'").first().catch(() => null);
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}

// Pour un bouton : { id, name, animated } ou { name: Unicode }.
export function emo(map, name) {
  const e = map && map[name];
  return e ? { id: e.id, name, animated: !!e.animated } : { name: FALLBACK[name] || '•' };
}

// Pour un texte : <:nom:id> (ou <a:nom:id> animé), sinon l'emoji Unicode.
export function etxt(map, name) {
  const e = map && map[name];
  return e ? `<${e.animated ? 'a' : ''}:${name}:${e.id}>` : (FALLBACK[name] || '');
}

// Liste les emojis de l'application et garde leurs identifiants.
export async function refreshEmojis(env) {
  const list = await discordApi(env, 'GET', `/applications/${env.DISCORD_APP_ID}/emojis`);
  const map = Object.fromEntries((list.items || []).filter((e) => e.name.startsWith('fb_')).map((e) => [e.name, { id: e.id, animated: !!e.animated }]));
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('emojis', ?)").bind(JSON.stringify(map)).run();
  return map;
}

// Envoie des emojis ({ name, image: data URI }) ; replace : remplace ceux qui existent déjà.
export async function uploadEmojis(env, emojis, replace = false) {
  const existing = await refreshEmojis(env);
  const done = [];
  for (const e of emojis.slice(0, 20)) {
    if (!/^fb_[a-z0-9_]{1,28}$/.test(e.name) || !/^data:image\/(png|gif);base64,/.test(e.image || '')) continue;
    if (existing[e.name]) {
      if (!replace) continue;
      await discordApi(env, 'DELETE', `/applications/${env.DISCORD_APP_ID}/emojis/${existing[e.name].id}`);
    }
    await discordApi(env, 'POST', `/applications/${env.DISCORD_APP_ID}/emojis`, { name: e.name, image: e.image });
    done.push(e.name);
  }
  return { uploaded: done, map: await refreshEmojis(env) };
}
