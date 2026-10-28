// Index de recherche dans Neon (Postgres gratuit, sans limite de lignes lues) : une copie légère du catalogue (titres,
// boutique, catégorie, prix, popularité…) où se font les recherches par mots, au lieu de parcourir les bases du
// catalogue (quota de lectures de Turso). Recherche tolérante aux fautes de frappe (trigrammes, pg_trgm).
// La copie est tenue à jour par tranches (syncSearchIndex, toutes les 15 min) ; tant qu'elle n'est pas complète, ou si
// Neon ne répond pas, la recherche se fait comme avant dans les bases.

import { neon, kvGet, kvSet } from './kvstore.js';
import { perDb, itemsWhereIds } from './shard.js';
import { mentionsBrand, brandNames } from './synonyms.js';
import { describeImage } from './vision.js';
import { DROP_WINDOW_DAYS } from './search.js';

// Texte indexé : titre anglais + la partie latine du titre chinois et de la boutique (« BAPE 卫衣 » → « bape »). Les
// caractères chinois ne sont pas indexés (ils triplaient la taille de l'index) : les mots chinois se cherchent sans index.
const TXT = "lower(coalesce(title_en,'') || ' ' || regexp_replace(coalesce(title_zh,'') || ' ' || coalesce(shop_name,''), '[^\\x01-\\x7f]+', ' ', 'g'))";
const CHUNK = 2500; // items par requête
const PER_RUN = 4; // requêtes par passage : 10 000 items toutes les 15 min

const SCHEMA = [
  'CREATE EXTENSION IF NOT EXISTS pg_trgm',
  `CREATE TABLE IF NOT EXISTS items_search (
     id TEXT PRIMARY KEY, title_en TEXT, title_zh TEXT, shop_name TEXT, shop_id TEXT, category TEXT,
     popularity INTEGER NOT NULL DEFAULT 0, first_seen BIGINT, price REAL, hidden SMALLINT NOT NULL DEFAULT 0,
     posted INTEGER NOT NULL DEFAULT 0, qc INTEGER NOT NULL DEFAULT 0, prev_price REAL, price_changed_at BIGINT)`,
  'DROP INDEX IF EXISTS items_search_txt',
  `CREATE INDEX IF NOT EXISTS items_search_latin ON items_search USING gin ((${TXT}) gin_trgm_ops)`,
  'CREATE INDEX IF NOT EXISTS items_search_pop ON items_search (popularity DESC, first_seen DESC)',
  // Marque lue sur la photo (scanBrands), pour les items dont le titre ne la donne pas ; brand_checked : déjà regardé.
  'ALTER TABLE items_search ADD COLUMN IF NOT EXISTS brand TEXT',
  'ALTER TABLE items_search ADD COLUMN IF NOT EXISTS brand_checked BIGINT',
  'CREATE INDEX IF NOT EXISTS items_search_brand ON items_search (brand) WHERE brand IS NOT NULL',
];

let schemaReady = null;
function ensureSchema(env) {
  schemaReady = schemaReady || (async () => { for (const q of SCHEMA) await neon(env, q); })()
    .catch((err) => { schemaReady = null; throw err; });
  return schemaReady;
}

// Nom de chaque base du catalogue (pour sa position de copie).
const dbTag = (e, env) => (e.DB.isD1 ? 'd1' : env.DB2 && e.DB === env.DB2 ? 'db2' : 'db1');

// Toutes les 15 min : la tranche suivante de chaque base copiée dans Neon. Quand une base a été copiée en entier, on
// recommence (prix, popularité et nombre de QC mis à jour à chaque tour). Renvoie le nombre d'items copiés.
export async function syncSearchIndex(env) {
  if (!env.NEON_URL) return 0;
  await ensureSchema(env);
  let copied = 0;
  for (const e of perDb(env)) {
    const tag = dbTag(e, env);
    let cursor = Number(await kvGet(env, `sidx:cursor:${tag}`)) || 0;
    for (let i = 0; i < PER_RUN; i++) {
      const { results } = await e.DB.prepare(
        `SELECT rowid AS rid, id, title_en, title_zh, shop_name, shop_id, category, popularity, first_seen, price_cny,
                hidden, posted_count, qc_count, prev_price, price_changed_at
         FROM items WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      ).bind(cursor, CHUNK).all();
      if (results.length) {
        await neon(env, `INSERT INTO items_search (id, title_en, title_zh, shop_name, shop_id, category, popularity, first_seen, price,
             hidden, posted, qc, prev_price, price_changed_at)
           SELECT id, title_en, title_zh, shop_name, shop_id, category, coalesce(popularity, 0), first_seen, price_cny,
             coalesce(hidden, 0), coalesce(posted_count, 0), coalesce(qc_count, 0), prev_price, price_changed_at
           FROM jsonb_to_recordset($1::jsonb) AS x(id TEXT, title_en TEXT, title_zh TEXT, shop_name TEXT, shop_id TEXT, category TEXT,
             popularity INTEGER, first_seen BIGINT, price_cny REAL, hidden SMALLINT, posted_count INTEGER, qc_count INTEGER,
             prev_price REAL, price_changed_at BIGINT)
           ON CONFLICT (id) DO UPDATE SET title_en = EXCLUDED.title_en, title_zh = EXCLUDED.title_zh, shop_name = EXCLUDED.shop_name,
             shop_id = EXCLUDED.shop_id, category = EXCLUDED.category, popularity = EXCLUDED.popularity, first_seen = EXCLUDED.first_seen,
             price = EXCLUDED.price, hidden = EXCLUDED.hidden, posted = EXCLUDED.posted, qc = EXCLUDED.qc,
             prev_price = EXCLUDED.prev_price, price_changed_at = EXCLUDED.price_changed_at`,
        [JSON.stringify(results.map(({ rid, ...x }) => x))]);
        copied += results.length;
        cursor = results[results.length - 1].rid;
      }
      if (results.length < CHUNK) {
        // Fin de la base : un tour complet est fait, on recommence au début au prochain passage.
        await kvSet(env, `sidx:done:${tag}`, Date.now());
        cursor = 0;
        break;
      }
    }
    await kvSet(env, `sidx:cursor:${tag}`, cursor);
  }
  return copied;
}

// L'index est utilisable quand chaque base du catalogue a été copiée en entier au moins une fois.
export async function searchIndexReady(env) {
  if (!env.NEON_URL || env.SEARCH_INDEX === '0') return false;
  const done = await Promise.all(perDb(env).map((e) => kvGet(env, `sidx:done:${dbTag(e, env)}`)));
  return done.every((v) => v);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const latinAlt = (s) => /^[a-z0-9' -]+$/.test(s);

// Même filtre que where() de search.js, en Postgres.
export function neonWhere(params, money) {
  const clauses = ['hidden = 0'];
  const binds = [];
  const p = (v) => { binds.push(v); return `$${binds.length}`; };
  for (const g of params.groups || []) {
    const ors = [];
    const latin = [];
    for (const a of g.alt) {
      if (latinAlt(a)) {
        const spaced = a.includes(' ') ? [a.replace(/ /g, ''), a.replace(/ /g, '-')] : [];
        for (const form of new Set([a, `${a}s`, ...spaced])) latin.push(esc(form));
      } else {
        const like = p(`%${a}%`);
        ors.push(`(lower(title_zh) LIKE ${like} OR lower(shop_name) LIKE ${like} OR lower(title_en) LIKE ${like})`);
      }
    }
    // Mot entier (lettres et chiffres autour exclus), toutes les formes en une seule expression.
    if (latin.length) ors.push(`${TXT} ~ ${p(`(^|[^a-z0-9])(${latin.join('|')})([^a-z0-9]|$)`)}`);
    if (g.cat) ors.push(`category = ${p(g.cat)}`);
    // Marque lue sur la photo (titre sans marque).
    const names = g.kind === 'brand' ? brandNames(g) : [];
    if (names.length) ors.push(`brand IN (SELECT jsonb_array_elements_text(${p(JSON.stringify(names))}::jsonb))`);
    if (ors.length) clauses.push(`(${ors.join(' OR ')})`);
  }
  if (params.min != null) clauses.push(`price >= ${p(params.min / money.rate)}`);
  if (params.max != null) clauses.push(`price <= ${p(params.max / money.rate)}`);
  if (params.shop) clauses.push(`shop_id = ${p(String(params.shop))}`);
  const category = params.category || params.autoCategory;
  if (category) clauses.push(`category = ${p(category)}`);
  if (!params.includePosted) clauses.push('posted = 0');
  if (params.trending) clauses.push('popularity > 0');
  if (params.withQc) clauses.push('qc > 0');
  if (params.drops) clauses.push(`prev_price > price AND price_changed_at > ${p(Date.now() - DROP_WINDOW_DAYS * 86400000)}`);
  return { sql: `WHERE ${clauses.join(' AND ')}`, binds };
}

const COLS = 'id, title_en, title_zh, shop_name, category, popularity, first_seen, price AS price_cny, brand';
const num = (r) => ({ ...r, popularity: Number(r.popularity) || 0, first_seen: Number(r.first_seen) || 0, price_cny: r.price_cny == null ? null : Number(r.price_cny) });

// Recherche par mots dans l'index (les 5 000 plus vendus qui correspondent). null si Neon ne répond pas.
export async function indexSearch(env, params, money) {
  const w = neonWhere(params, money);
  try {
    const rows = await neon(env, `SELECT ${COLS} FROM items_search ${w.sql} ORDER BY popularity DESC, first_seen DESC LIMIT 5000`, w.binds);
    return rows.map(num);
  } catch (err) {
    console.log('index de recherche', String(err).slice(0, 160));
    return null;
  }
}

// Fautes de frappe (« suprem hodie ») : items dont le texte contient un mot proche de chacun des mots cherchés
// (similarité de trigrammes). Seulement quand la recherche normale trouve trop peu. [] si rien.
export async function fuzzySearch(env, words, params, money) {
  const list = (words || []).filter((x) => x.length >= 3).slice(0, 4);
  if (!list.length) return [];
  const w = neonWhere({ ...params, groups: [] }, money);
  const conds = list.map((x) => { w.binds.push(x); return `$${w.binds.length} <% ${TXT}`; });
  try {
    const rows = await neon(env,
      `SELECT ${COLS} FROM items_search ${w.sql} AND ${conds.join(' AND ')} ORDER BY popularity DESC, first_seen DESC LIMIT 200`, w.binds);
    return rows.map(num);
  } catch (err) {
    console.log('recherche approchante', String(err).slice(0, 160));
    return [];
  }
}

// Toutes les 3 min : la marque des items populaires dont le titre ne cite aucune marque, lue sur leur photo (modèle de
// vision chez OVH, gratuit : les quotas d'IA du jour restent aux membres). Des plus vendus aux moins vendus.
// Renvoie le nombre d'items regardés.
const SCAN_PER_RUN = 6;
export async function scanBrands(env) {
  if (!env.NEON_URL || env.BRAND_SCAN === '0') return 0;
  await ensureSchema(env);
  const rows = await neon(env, `SELECT id, title_en, title_zh, shop_name FROM items_search
    WHERE brand_checked IS NULL AND hidden = 0 AND popularity >= 20 ORDER BY popularity DESC LIMIT 60`);
  if (!rows.length) return 0;
  // Titre qui cite déjà une marque (nom, modèle ou nom codé) : rien à lire.
  const named = rows.filter((r) => mentionsBrand(`${r.title_en || ''} ${r.title_zh || ''} ${r.shop_name || ''}`)).map((r) => r.id);
  const todo = rows.filter((r) => !named.includes(r.id)).slice(0, SCAN_PER_RUN);
  const items = new Map((await itemsWhereIds(env, todo.map((r) => r.id))).map((i) => [i.id, i]));
  const found = [];
  for (const r of todo) {
    const image = (items.get(r.id) || {}).image;
    let brand = '';
    if (/^https:\/\//.test(image || '')) {
      const seen = await describeImage(env, image, undefined, 'ovh-only').catch((err) => { console.log('marque (photo)', String(err).slice(0, 120)); return undefined; });
      if (seen === undefined) break; // OVH saturé : on reprendra au prochain passage
      brand = seen && seen.brand ? seen.brand.toLowerCase().slice(0, 40) : '';
    }
    found.push({ id: r.id, brand });
  }
  const marks = [...named.map((id) => ({ id, brand: null })), ...found];
  if (marks.length) {
    await neon(env, `UPDATE items_search s SET brand = coalesce(nullif(x.brand, ''), s.brand), brand_checked = $2
      FROM jsonb_to_recordset($1::jsonb) AS x(id TEXT, brand TEXT) WHERE s.id = x.id`, [JSON.stringify(marks), Date.now()]);
  }
  return found.length;
}
