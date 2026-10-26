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
  if (params.withQc) clauses.push('(qc_count > 0 OR EXISTS (SELECT 1 FROM qc_posts q WHERE q.item_id = items.id))');
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

export async function allResultIds(env, params, rate) {
  const w = where(params, rate);
  const { results } = await env.DB.prepare(
    `SELECT id FROM items ${w.sql} ORDER BY ${order(params)} LIMIT ?`,
  ).bind(...w.binds, MAX_BULK).all();
  return results.map((r) => r.id);
}

// Résultats d'une recherche enregistrée, mis en cache dans ses paramètres (_ids) : une seule lecture de la table
// par recherche, puis pagination, « tout poster » et /find réutilisent la liste (quota de lectures D1).
export async function searchIds(env, sid, params, money) {
  if (Array.isArray(params._ids)) return params._ids;
  const { _ids, ...clean } = params;
  const ids = await allResultIds(env, clean, money);
  params._ids = ids;
  await env.DB.prepare('UPDATE searches SET params = ? WHERE id = ?').bind(JSON.stringify(params), sid).run();
  return ids;
}

// Items d'une tranche de la liste, dans l'ordre de la liste (sans les items masqués entre-temps).
export async function itemsByIds(env, ids) {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(`SELECT * FROM items WHERE hidden = 0 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const byId = new Map(results.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// Paramètres sans le cache (à utiliser dès qu'un filtre change).
export function withoutCache(params) {
  const { _ids, ...clean } = params;
  return clean;
}

// Liste à poster : sans les items postés depuis la création du cache (si la recherche exclut les déjà postés).
export async function idsToPost(env, sid, params, money) {
  const ids = await searchIds(env, sid, params, money);
  if (params.includePosted || !ids.length) return ids;
  const keep = new Set();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT id FROM items WHERE posted_count = 0 AND hidden = 0 AND id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk).all();
    results.forEach((r) => keep.add(r.id));
  }
  return ids.filter((id) => keep.has(id));
}
