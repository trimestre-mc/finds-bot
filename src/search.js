// Recherche dans les items indexés.

import { translate } from './translate.js';

export const PAGE_SIZE = 5;
export const MAX_BULK = 500;

function terms(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 8);
}

// Prépare les variantes de la requête (telle quelle, en anglais, en chinois).
export async function prepareQuery(env, q) {
  const variants = [];
  const original = terms(q);
  if (original.length) variants.push(original);
  if (q && q.trim()) {
    let english = q;
    try {
      english = await translate(env, q, 'fr', 'en') || q;
      const en = terms(english);
      if (en.length && en.join(' ') !== original.join(' ')) variants.push(en);
    } catch {}
    try {
      const zh = (await translate(env, english, 'en', 'zh')).replace(/[\s。.,，!！?？]/g, '');
      if (zh && zh.length <= 8) variants.push([zh]);
    } catch {}
  }
  return variants;
}

export const SORTS = {
  popular: { label: 'Les plus vendus', emoji: '🔥', sql: 'popularity DESC, first_seen DESC, id' },
  recent: { label: 'Les plus récents', emoji: '✨', sql: 'first_seen DESC, id' },
  price_asc: { label: 'Prix croissant', emoji: '⬆️', sql: 'price_cny IS NULL, price_cny ASC, id' },
  price_desc: { label: 'Prix décroissant', emoji: '⬇️', sql: 'price_cny DESC, id' },
};
export const DROP_WINDOW_DAYS = 14;

// Construit la clause WHERE à partir des paramètres enregistrés d'une recherche.
// money.rate convertit les prix min/max (dans la devise choisie) en ¥.
function where(params, money) {
  const clauses = ['hidden = 0'];
  const binds = [];
  if (params.variants && params.variants.length) {
    const ors = params.variants.map((words) => {
      const ands = words.map((w) => {
        binds.push(`%${w}%`);
        return `(LOWER(COALESCE(title_en,'') || ' ' || COALESCE(title_zh,'') || ' ' || COALESCE(shop_name,'')) LIKE ?)`;
      });
      return `(${ands.join(' AND ')})`;
    });
    clauses.push(`(${ors.join(' OR ')})`);
  }
  if (params.min != null) {
    clauses.push('price_cny >= ?');
    binds.push(params.min / money.rate);
  }
  if (params.max != null) {
    clauses.push('price_cny <= ?');
    binds.push(params.max / money.rate);
  }
  if (params.shop) {
    clauses.push('shop_id = ?');
    binds.push(params.shop);
  }
  if (params.category) {
    clauses.push('category = ?');
    binds.push(params.category);
  }
  if (!params.includePosted) clauses.push('posted_count = 0');
  if (params.trending) clauses.push('popularity > 0');
  if (params.drops) {
    clauses.push('prev_price > price_cny AND price_changed_at > ?');
    binds.push(Date.now() - DROP_WINDOW_DAYS * 86400000);
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, binds };
}

// Tri choisi, sinon : nouveautés = récents d'abord, le reste = plus vendus d'abord.
function order(params) {
  if (params.sort && SORTS[params.sort]) return SORTS[params.sort].sql;
  return params.latest ? SORTS.recent.sql : SORTS.popular.sql;
}

export async function countResults(env, params, rate) {
  const w = where(params, rate);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM items ${w.sql}`).bind(...w.binds).first();
  return row ? row.n : 0;
}

export async function pageResults(env, params, rate, page) {
  const w = where(params, rate);
  const { results } = await env.DB.prepare(
    `SELECT * FROM items ${w.sql} ORDER BY ${order(params)} LIMIT ? OFFSET ?`,
  ).bind(...w.binds, PAGE_SIZE, page * PAGE_SIZE).all();
  return results;
}

export async function allResultIds(env, params, rate) {
  const w = where(params, rate);
  const { results } = await env.DB.prepare(
    `SELECT id FROM items ${w.sql} ORDER BY ${order(params)} LIMIT ?`,
  ).bind(...w.binds, MAX_BULK).all();
  return results.map((r) => r.id);
}
