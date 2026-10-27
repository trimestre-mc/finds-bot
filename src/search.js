// Recherche dans les items indexés.

import { relevance, relaxQuery } from './synonyms.js';
import { addLiveResults } from './livesearch.js';
import { readsOver } from './budget.js';
import { perDb, allRows, itemsWhereIds } from './shard.js';
import { translate } from './translate.js';
import { detectCategory } from './categories.js';

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
  // Ordres qui suivent un index (popularité) ou la table elle-même (rowid = ordre d'arrivée) : la recherche
  // s'arrête dès qu'elle a ses résultats, au lieu de lire toute la table (quota de lectures).
  popular: { label: 'Les plus vendus', emoji: '🔥', sql: 'popularity DESC, first_seen DESC' },
  recent: { label: 'Les plus récents', emoji: '✨', sql: 'rowid DESC' },
  price_asc: { label: 'Prix croissant', emoji: '⬆️', sql: 'price_cny IS NULL, price_cny ASC, id' },
  price_desc: { label: 'Prix décroissant', emoji: '⬇️', sql: 'price_cny DESC, id' },
};
export const DROP_WINDOW_DAYS = 14;

// Construit la clause WHERE à partir des paramètres enregistrés d'une recherche.
// money.rate convertit les prix min/max (dans la devise choisie) en ¥.
// Texte cherché d'un item, entouré d'espaces (pour les mots entiers avec GLOB).
const ITEM_TEXT = "(' ' || LOWER(COALESCE(title_en,'') || ' ' || COALESCE(title_zh,'') || ' ' || COALESCE(shop_name,'')) || ' ')";
const latinAlt = (s) => /^[a-z0-9' -]+$/.test(s);

function where(params, money) {
  const clauses = ['hidden = 0'];
  const binds = [];
  if (params.groups && params.groups.length) {
    // Chaque groupe (mot cherché et ses équivalents) doit correspondre : mot latin entier (GLOB), mot chinois
    // n'importe où, ou item déjà classé dans le type d'article cherché.
    for (const g of params.groups) {
      const ors = [];
      for (const a of g.alt) {
        if (latinAlt(a)) {
          // « tech fleece » trouve aussi « techfleece » et « tech-fleece ».
          const spaced = a.includes(' ') ? [a.replace(/ /g, ''), a.replace(/ /g, '-')] : [];
          for (const form of new Set([a, `${a}s`, ...spaced])) {
            ors.push(`${ITEM_TEXT} GLOB ?`);
            binds.push(`*[^a-z0-9]${form}[^a-z0-9]*`);
          }
        } else {
          ors.push(`${ITEM_TEXT} LIKE ?`);
          binds.push(`%${a}%`);
        }
      }
      if (g.cat) {
        ors.push('category = ?');
        binds.push(g.cat);
      }
      clauses.push(`(${ors.join(' OR ')})`);
    }
  } else if (params.variants && params.variants.length) {
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
  const category = params.category || params.autoCategory;
  if (category) {
    clauses.push('category = ?');
    binds.push(category);
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

const FEW_RESULTS = 10;
const SCAN_ROWS = 200000;

export async function allResultIds(env, params, money) {
  if (params.groups && params.groups.length) {
    // Peu de résultats avec tous les mots : on complète sans le moins important (couleur, puis type, puis mot
    // inconnu). Les résultats exacts restent en tête.
    // Tout le catalogue FinderQC en direct (pas pour une recherche limitée à une boutique).
    if (!params.shop && params.live !== false) await addLiveResults(env, params, money);
    let groups = params.groups;
    const ids = [];
    for (let tries = 0; groups && tries < 3 && ids.length < FEW_RESULTS; tries++, groups = relaxQuery(groups)) {
      for (const id of await rankedIds(env, { ...params, groups }, money)) if (!ids.includes(id)) ids.push(id);
    }
    return ids.slice(0, MAX_BULK);
  }
  return plainIds(env, params, money);
}

async function rankedIds(env, params, money) {
  const w = where(params, money);
  // Recherche par mots : les plus pertinents d'abord (mots trouvés dans le titre anglais, bon type d'article),
  // puis le tri choisi. On parcourt l'index de popularité et on s'arrête à 5000 trouvés (quota de lectures Turso),
  // puis cache partagé de 6 h.
  // Lecture bornée : au plus les SCAN_ROWS items les plus vendus (3 000 si le quota de lectures du mois est atteint).
  // Chaque base du catalogue lit sa moitié, avec son propre quota.
  const parts = await Promise.all(perDb(env).map(async (e) => {
    const scan = (await readsOver(e)) ? 3000 : SCAN_ROWS;
    return (await e.DB.prepare(
      `SELECT id, title_en, title_zh, shop_name, category, popularity, first_seen, price_cny FROM (
         SELECT * FROM items INDEXED BY items_popularity ORDER BY popularity DESC, first_seen DESC LIMIT ?
       ) ${w.sql} LIMIT 5000`,
    ).bind(scan, ...w.binds).all()).results;
  }));
  const results = parts.flat();
  const scored = results.map((r) => ({ ...r, score: relevance(params.groups, r) })).filter((r) => r.score > 0);
  const sorted = sortRows(scored, params);
  if (!params.sort || params.sort === 'popular') sorted.sort((a, b) => b.score - a.score || b.popularity - a.popularity || b.first_seen - a.first_seen);
  // Même produit chez plusieurs vendeurs : on garde le premier (le plus vendu). Les longs titres copiés-collés
  // d'un grossiste à l'autre comptent comme doublons même à un prix différent.
  const seen = new Set();
  const unique = sorted.filter((r) => {
    const title = (r.title_en || r.title_zh || r.id).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const key = title.length > 40 ? title : `${title}|${r.price_cny}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, MAX_BULK).map((r) => r.id);
}

async function plainIds(env, params, money) {
  const w = where(params, money);
  if ((params.category || params.autoCategory) && (!params.sort || params.sort === 'popular') && !params.latest) {
    // Catégorie, les plus vendus d'abord (salons par catégorie, drops) : on parcourt l'index de popularité et on
    // s'arrête aux MAX_BULK premiers de la catégorie, au lieu de lire toute la catégorie (jusqu'à ~100 000 lignes).
    const results = await allRows(env,
      `SELECT id, popularity, first_seen, price_cny FROM items INDEXED BY items_popularity ${w.sql} ORDER BY popularity DESC, first_seen DESC LIMIT ?`,
      ...w.binds, MAX_BULK);
    return sortRows(results, params).slice(0, MAX_BULK).map((r) => r.id);
  }
  if (params.category || params.autoCategory) {
    // Autres tris dans une catégorie : on lit seulement cette catégorie (index), puis on trie ici.
    const results = await allRows(env, `SELECT id, popularity, first_seen, price_cny FROM items INDEXED BY items_category ${w.sql}`, ...w.binds);
    return sortRows(results, params).slice(0, MAX_BULK).map((r) => r.id);
  }
  // Les meilleurs de chaque base, puis fusion dans l'ordre demandé.
  const results = await allRows(env, `SELECT id, popularity, first_seen, price_cny FROM items ${w.sql} ORDER BY ${order(params)} LIMIT ?`,
    ...w.binds, MAX_BULK);
  return sortRows(results, params).slice(0, MAX_BULK).map((r) => r.id);
}

function sortRows(rows, params) {
  const sort = params.sort || (params.latest ? 'recent' : 'popular');
  const by = {
    popular: (a, b) => b.popularity - a.popularity || b.first_seen - a.first_seen,
    recent: (a, b) => b.first_seen - a.first_seen,
    price_asc: (a, b) => (a.price_cny ?? Infinity) - (b.price_cny ?? Infinity),
    price_desc: (a, b) => (b.price_cny ?? -Infinity) - (a.price_cny ?? -Infinity),
  }[sort] || ((a, b) => b.popularity - a.popularity);
  return rows.sort(by);
}

// Catégorie déduite des mots cherchés (« black hoodie » → hoodies), si un seul type d'article est cité.
export function inferCategory(variants) {
  for (const words of variants || []) {
    const c = detectCategory(words.join(' '));
    if (c !== 'other') return c;
  }
  return null;
}

// Cache partagé entre recherches identiques (6 h) : une même recherche ne relit pas la base.
const CACHE_MS = 6 * 3600000;
function cacheKey(params) {
  const { _ids, public: _p, shopName, ...rest } = params;
  return 'v3' + JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]));
}

export async function cachedIds(env, params, money) {
  const key = cacheKey(params);
  const row = await env.DB.prepare('SELECT ids, at FROM search_cache WHERE key = ?').bind(key).first().catch(() => null);
  if (row && Date.now() - row.at < CACHE_MS) return JSON.parse(row.ids);
  const ids = await allResultIds(env, params, money);
  await env.DB.prepare('INSERT OR REPLACE INTO search_cache (key, ids, at) VALUES (?, ?, ?)')
    .bind(key, JSON.stringify(ids), Date.now()).run().catch(() => {});
  return ids;
}

// Résultats d'une recherche enregistrée, mis en cache dans ses paramètres (_ids) : une seule lecture de la table
// par recherche, puis pagination, « tout poster » et /find réutilisent la liste (quota de lectures D1).
export async function searchIds(env, sid, params, money) {
  if (Array.isArray(params._ids)) return params._ids;
  const { _ids, ...clean } = params;
  const ids = await cachedIds(env, clean, money);
  params._ids = ids;
  await env.DB.prepare('UPDATE searches SET params = ? WHERE id = ?').bind(JSON.stringify(params), sid).run();
  return ids;
}

// Items d'une tranche de la liste, dans l'ordre de la liste (sans les items masqués entre-temps).
export async function itemsByIds(env, ids) {
  if (!ids.length) return [];
  const results = await itemsWhereIds(env, ids, '*', 'hidden = 0');
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
    const results = await itemsWhereIds(env, chunk, 'id', 'posted_count = 0 AND hidden = 0');
    results.forEach((r) => keep.add(r.id));
  }
  return ids.filter((id) => keep.has(id));
}
