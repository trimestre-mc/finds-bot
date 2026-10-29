// Recherche dans les items indexés.

import { relevance, relaxQuery, expandQuery } from './synonyms.js';
import { addLiveResults } from './livesearch.js';
import { readsOver } from './budget.js';
import { perDb, allRows, itemsWhereIds } from './shard.js';
import { translate } from './translate.js';
import { detectCategory } from './categories.js';
import { cacheGet, cacheSet, logEvent, redis } from './kvstore.js';
import { searchIndexReady, indexSearch, fuzzySearch, indexList, indexItems } from './searchindex.js';

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

export function where(params, money) {
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
    const indexed = await searchIndexReady(env).catch(() => false);
    // Sans l'index : recherche en direct chez FinderQC d'abord (ajoutée aux bases). Avec l'index : seulement si l'index
    // trouve trop peu (plus rapide, et FinderQC moins sollicité).
    if (!indexed && !params.shop && params.live !== false) await addLiveResults(env, params, money);
    let groups = params.groups;
    const ids = [];
    for (let tries = 0; groups && tries < 3 && ids.length < FEW_RESULTS; tries++, groups = relaxQuery(groups)) {
      for (const id of await rankedIds(env, { ...params, groups }, money, indexed)) if (!ids.includes(id)) ids.push(id);
    }
    if (indexed && ids.length < FEW_RESULTS && !params.shop && params.live !== false && await addLiveResults(env, params, money, true)) {
      for (const id of await rankedIds(env, params, money, indexed)) if (!ids.includes(id)) ids.push(id);
    }
    // Toujours trop peu : faute de frappe probable (« hodie », « jordna »), mots approchants dans l'index.
    if (indexed && ids.length < FEW_RESULTS && params.q) {
      const words = String(params.q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      for (const r of await fuzzySearch(env, words, params, money)) if (!ids.includes(r.id)) ids.push(r.id);
    }
    return ids.slice(0, MAX_BULK);
  }
  return plainIds(env, params, money);
}

async function rankedIds(env, params, money, indexed = false) {
  // Index de recherche (Neon) complet : la recherche s'y fait, sans lire les bases du catalogue.
  const fromIndex = indexed ? await indexSearch(env, params, money) : null;
  if (fromIndex) return rankRows(fromIndex, params);
  const w = where(params, money);
  // Recherche par mots : les plus pertinents d'abord (mots trouvés dans le titre anglais, bon type d'article),
  // puis le tri choisi. On parcourt l'index de popularité et on s'arrête à 5000 trouvés (quota de lectures Turso),
  // puis cache partagé de 6 h.
  // Lecture bornée : au plus les SCAN_ROWS items les plus vendus (3 000 si le quota de lectures du mois est atteint).
  // Chaque base du catalogue lit sa moitié, avec son propre quota.
  const parts = await Promise.all(perDb(env).map(async (e) => {
    // D1 (5 M lectures/jour) : 20 000 lignes au plus par recherche.
    const scan = (await readsOver(e)) ? 3000 : e.DB.isD1 ? 20000 : SCAN_ROWS;
    return (await e.DB.prepare(
      // Secours si l'index de recherche (Neon) ne répond pas : les items les plus récents (ordre d'arrivée, sans
      // index en plus, voir schema.sql).
      `SELECT id, title_en, title_zh, shop_name, category, popularity, first_seen, price_cny FROM (
         SELECT * FROM items ORDER BY rowid DESC LIMIT ?
       ) ${w.sql} LIMIT 5000`,
    ).bind(scan, ...w.binds).all()).results;
  }));
  return rankRows(parts.flat(), params);
}

// Pertinence, tri et doublons d'une liste de résultats (bases ou index).
// Accessoires « pour » une marque (inserts de sac, coques, boîtes, stickers…) : ils passent après les vrais articles,
// sauf si la recherche les demande (« lv insert », « coque stone island »).
const ACCESSORY = /\b(suitable for|compatible|for (lv|louis|gucci|dior|chanel|hermes|prada|goyard|ysl|celine)|phone case|case for|iphone|airpods|storage|organi[sz]er|insert|liner|lining bag|dust ?bag|gift box|box only|sticker|keychain|key chain|lanyard|shoelace|lace)\b/i;
function rankRows(results, params) {
  const wantsAccessory = ACCESSORY.test((params.groups || []).map((g) => g.alt.join(' ')).join(' '));
  const scored = results.map((r) => ({ ...r, score: relevance(params.groups, r) })).filter((r) => r.score > 0)
    .map((r) => (!wantsAccessory && ACCESSORY.test(r.title_en || '') ? { ...r, score: r.score - 2.5 } : r));
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
  // Listes (catégorie, nouveautés, baisses de prix…) : dans l'index de recherche Neon, sans lire les bases ni avoir
  // besoin de leurs index de popularité et de catégorie (retirés pour écrire moins par item, voir schema.sql).
  if (await searchIndexReady(env).catch(() => false)) {
    const rows = await indexList(env, params, money);
    if (rows) {
      let ids = rows.map((r) => r.id);
      // L'index est mis à jour une fois par jour : « déjà posté » et « masqué » revérifiés dans les bases.
      if (!params.includePosted || ids.length) ids = await stillListable(env, ids.slice(0, MAX_BULK * 2), !params.includePosted);
      return ids.slice(0, MAX_BULK);
    }
  }
  const w = where(params, money);
  if ((params.category || params.autoCategory) && (!params.sort || params.sort === 'popular') && !params.latest) {
    // Catégorie, les plus vendus d'abord (salons par catégorie, drops) : on parcourt l'index de popularité et on
    // s'arrête aux MAX_BULK premiers de la catégorie, au lieu de lire toute la catégorie (jusqu'à ~100 000 lignes).
    const results = await allRows(env,
      `SELECT id, popularity, first_seen, price_cny FROM items ${w.sql} ORDER BY popularity DESC, first_seen DESC LIMIT ?`,
      ...w.binds, MAX_BULK);
    return sortRows(results, params).slice(0, MAX_BULK).map((r) => r.id);
  }
  if (params.category || params.autoCategory) {
    // Autres tris dans une catégorie : on lit seulement cette catégorie (index), puis on trie ici.
    const results = await allRows(env, `SELECT id, popularity, first_seen, price_cny FROM items ${w.sql}`, ...w.binds);
    return sortRows(results, params).slice(0, MAX_BULK).map((r) => r.id);
  }
  // Les meilleurs de chaque base, puis fusion dans l'ordre demandé.
  const results = await allRows(env, `SELECT id, popularity, first_seen, price_cny FROM items ${w.sql} ORDER BY ${order(params)} LIMIT ?`,
    ...w.binds, MAX_BULK);
  return sortRows(results, params).slice(0, MAX_BULK).map((r) => r.id);
}

// Items encore proposables (pas masqués, et pas déjà postés si unposted), dans l'ordre donné. Par paquets de 90
// (limite de paramètres d'une requête D1).
async function stillListable(env, ids, unposted) {
  const ok = new Set();
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await itemsWhereIds(env, ids.slice(i, i + 90), 'id', unposted ? 'hidden = 0 AND posted_count = 0' : 'hidden = 0').catch(() => null);
    if (!rows) return ids; // base illisible : on garde la liste de l'index
    for (const r of rows) ok.add(r.id);
  }
  return ids.filter((id) => ok.has(id));
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
  if (params.q) await logEvent(env, 'search', `« ${String(params.q).slice(0, 60)} »`).catch(() => {});
  // Recherches /find les plus faites : comptées pour être recalculées à l'avance (prewarmPopular).
  if (params.q && params.public) {
    await redis(env, [['ZINCRBY', 'q:pop', '1', String(params.q).toLowerCase().trim().slice(0, 100)], ['ZREMRANGEBYRANK', 'q:pop', '0', '-501']]).catch(() => {});
  }
  const key = cacheKey(params);
  const row = await cacheGet(env, key);
  if (row && Date.now() - row.at < CACHE_MS) return JSON.parse(row.ids);
  const ids = await allResultIds(env, params, money);
  await cacheSet(env, key, JSON.stringify(ids));
  return ids;
}

// Résultats d'une recherche enregistrée, mis en cache dans ses paramètres (_ids) : une seule lecture de la table
// par recherche, puis pagination, « tout poster » et /find réutilisent la liste (quota de lectures D1).
export async function searchIds(env, sid, params, money) {
  if (Array.isArray(params._ids)) return params._ids;
  const { _ids, ...clean } = params;
  const ids = await cachedIds(env, clean, money);
  params._ids = ids;
  const { updateSearch } = await import('./ui.js');
  await updateSearch(env, sid, { params });
  return ids;
}

// Items d'une tranche de la liste, dans l'ordre de la liste (sans les items masqués entre-temps).
export async function itemsByIds(env, ids) {
  if (!ids.length) return [];
  // Base illisible (quota du jour) : les fiches viennent de l'index de recherche Neon (sans photo).
  const results = await itemsWhereIds(env, ids, '*', 'hidden = 0').catch(async (err) => {
    console.log('fiches (base illisible, index Neon)', String(err).slice(0, 100));
    return indexItems(env, ids);
  });
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
    // Base illisible : on garde la tranche telle quelle (l'index Neon a déjà retiré les items postés).
    const results = await itemsWhereIds(env, chunk, 'id', 'posted_count = 0 AND hidden = 0').catch(() => chunk.map((id) => ({ id })));
    results.forEach((r) => keep.add(r.id));
  }
  return ids.filter((id) => keep.has(id));
}

// Toutes les 30 min : les 25 recherches /find les plus faites sont recalculées à l'avance (mêmes paramètres que /find),
// leur résultat est alors instantané. Au plus ~25 s de travail par passage. Renvoie le nombre recalculé.
export async function prewarmPopular(env, n = 25) {
  const r = await redis(env, [['ZREVRANGE', 'q:pop', '0', String(n - 1)]]);
  const queries = (r && r[0]) || [];
  const { getRate } = await import('./post.js');
  const money = await getRate(env).catch(() => ({ rate: 0.13, code: 'EUR' }));
  const until = Date.now() + 25000;
  let done = 0;
  for (const q of queries) {
    if (Date.now() > until) break;
    const params = { q, groups: expandQuery(q), variants: [], category: null, autoCategory: null, max: null, includePosted: true, sort: 'popular', public: true };
    const key = cacheKey(params);
    const row = await cacheGet(env, key);
    if (row && Date.now() - row.at < CACHE_MS - 3600000) continue; // encore frais plus d'une heure
    const ids = await allResultIds(env, params, money).catch(() => null);
    if (!ids) continue;
    await cacheSet(env, key, JSON.stringify(ids));
    done++;
  }
  return done;
}
