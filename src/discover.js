// Découverte de boutiques : à partir de liens (collés en masse ou lus dans des salons Discord),
// on retrouve les boutiques Weidian et on les ajoute aux catalogues.

import { discordApi } from './discord.js';
import { fetchWeidianItem } from './weidian.js';

// Décode plusieurs fois (les liens d'agents contiennent souvent le lien Weidian encodé).
function decodeAll(text) {
  let s = String(text || '');
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(s.replace(/\+/g, ' '));
      if (next === s) break;
      s = next;
    } catch {
      break;
    }
  }
  return s;
}

const ITEM_PATTERNS = [
  /weidian\.com\/item\.html\?[^\s"'<>]*?itemI[dD]=(\d{6,12})/g,
  /\/(?:goods|product|products|item)\/weidian\/(\d{6,12})/gi,
  /[?&](?:id|itemId|itemID|goodsId|goods_id)=(\d{6,12})[^\s"'<>]*?[?&](?:shop_type|platform|channel|source|shopType)=(?:weidian|wd)\b/gi,
  /[?&](?:shop_type|platform|channel|source|shopType)=(?:weidian|wd)[^\s"'<>]*?[?&](?:id|itemId|itemID|goodsId|goods_id)=(\d{6,12})/gi,
];
const SHOP_PATTERNS = [
  /weidian\.com\/?\?[^\s"'<>]*?userid=(\d{5,12})/gi,
  /shop(\d{5,12})\.v\.weidian\.com/gi,
  /weidian\.com\/s\/(\d{5,12})/gi,
];

// Extrait les boutiques et les items Weidian d'un texte quelconque.
export function extractWeidian(text) {
  const s = decodeAll(text);
  const shops = new Set();
  const items = new Set();
  for (const re of SHOP_PATTERNS) for (const m of s.matchAll(re)) shops.add(m[1]);
  for (const re of ITEM_PATTERNS) for (const m of s.matchAll(re)) items.add(m[1]);
  const others = (s.match(/(?:taobao\.com|tmall\.com|1688\.com)\/\S+/gi) || []).length;
  return { shops, items, others };
}

// Tout le texte utile d'un message Discord : contenu, embeds, boutons (liens d'agents des autres bots).
export function messageText(m) {
  const parts = [m.content || ''];
  for (const e of m.embeds || []) parts.push(e.url || '', e.title || '', e.description || '', ...(e.fields || []).map((f) => f.value));
  const walk = (list) => {
    for (const c of list || []) {
      if (c.url) parts.push(c.url);
      if (c.content) parts.push(c.content);
      if (c.components) walk(c.components);
      if (c.accessory) walk([c.accessory]);
    }
  };
  walk(m.components);
  return parts.join('\n');
}

// Ajoute une boutique si elle est nouvelle. Renvoie true si ajoutée.
export async function addShopQuiet(env, shopId, name, source, by) {
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO shops (id, platform, name, url, status, source, added_by, added_at)
     VALUES (?, 'weidian', ?, ?, 'pending', ?, ?, ?)`,
  ).bind(shopId, name || null, `https://weidian.com/?userid=${shopId}`, source, by || null, Date.now()).run();
  return r.meta.changes > 0;
}

// Enregistre des liens trouvés : boutiques ajoutées tout de suite, items mis en file pour retrouver leur boutique.
export async function ingest(env, found, source, by) {
  let shopsAdded = 0;
  for (const id of found.shops) if (await addShopQuiet(env, id, null, source, by)) shopsAdded++;
  const ids = [...found.items];
  let queued = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const stmts = ids.slice(i, i + 50).map((id) => env.DB.prepare(
      `INSERT OR IGNORE INTO link_queue (item_id, source, added_at)
       SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM items WHERE id = 'weidian:' || ?)`,
    ).bind(id, source, Date.now(), id));
    const res = await env.DB.batch(stmts);
    queued += res.reduce((n, r) => n + (r.meta.changes || 0), 0);
  }
  return { shopsAdded, queued, others: found.others };
}

// Retrouve la boutique des items en file (1 page Weidian par item). Renvoie le nombre de boutiques ajoutées.
export async function resolveQueue(env, limit) {
  const { results } = await env.DB.prepare('SELECT item_id, source FROM link_queue ORDER BY added_at LIMIT ?').bind(limit).all();
  let added = 0;
  for (const row of results) {
    try {
      const known = await env.DB.prepare('SELECT shop_id FROM items WHERE id = ?').bind(`weidian:${row.item_id}`).first();
      if (!known) {
        const info = await fetchWeidianItem(row.item_id);
        if (info.shopId && await addShopQuiet(env, info.shopId, info.shopName, row.source, null)) added++;
      }
    } catch (err) {
      console.log('résolution', row.item_id, String(err).slice(0, 120));
    }
    await env.DB.prepare('DELETE FROM link_queue WHERE item_id = ?').bind(row.item_id).run();
  }
  return added;
}

// Lit les nouveaux messages d'un salon source. backfill = nombre de pages d'historique à lire la première fois.
export async function scanSource(env, source, backfill = 0) {
  const found = { shops: new Set(), items: new Set(), others: 0 };
  let messages = [];
  let newest = source.last_message_id;
  let calls = 0;
  if (source.last_message_id) {
    messages = await discordApi(env, 'GET', `/channels/${source.channel_id}/messages?limit=100&after=${source.last_message_id}`);
    calls++;
  } else {
    let before = '';
    for (let p = 0; p < Math.max(1, backfill); p++) {
      const page = await discordApi(env, 'GET', `/channels/${source.channel_id}/messages?limit=100${before ? `&before=${before}` : ''}`);
      calls++;
      messages.push(...page);
      if (page.length < 100) break;
      before = page[page.length - 1].id;
    }
  }
  let withText = 0;
  for (const m of messages) {
    const t = messageText(m);
    if (t.trim()) withText++;
    const f = extractWeidian(t);
    f.shops.forEach((x) => found.shops.add(x));
    f.items.forEach((x) => found.items.add(x));
    found.others += f.others;
    if (!newest || BigInt(m.id) > BigInt(newest)) newest = m.id;
  }
  const res = await ingest(env, found, `discord:${source.channel_id}`, source.added_by);
  await env.DB.prepare(
    'UPDATE sources SET last_message_id = ?, scanned_at = ?, messages = messages + ?, links = links + ?, error = NULL WHERE channel_id = ?',
  ).bind(newest || null, Date.now(), messages.length, found.shops.size + found.items.size, source.channel_id).run();
  // Des messages sans aucun texte lisible : l'intent « Message Content » n'est sans doute pas activé.
  return { ...res, messages: messages.length, noContent: messages.length > 5 && withText === 0, calls };
}

// Appelé toutes les 5 minutes : nouveaux messages des sources + résolution des items en file.
export async function runDiscovery(env) {
  const { results } = await env.DB.prepare('SELECT * FROM sources ORDER BY scanned_at LIMIT 8').all();
  let calls = 0;
  for (const s of results) {
    try {
      calls += (await scanSource(env, s, 5)).calls;
    } catch (err) {
      calls++;
      await env.DB.prepare('UPDATE sources SET error = ?, scanned_at = ? WHERE channel_id = ?')
        .bind(String(err.message || err).slice(0, 200), Date.now(), s.channel_id).run();
    }
  }
  await resolveQueue(env, Math.max(0, 40 - calls));
}
