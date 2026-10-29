// Index de recherche dans Neon (Postgres gratuit, sans limite de lignes lues) : une copie légère du catalogue (titres,
// boutique, catégorie, prix, popularité…) où se font les recherches par mots, au lieu de parcourir les bases du
// catalogue (quota de lectures de Turso). Recherche tolérante aux fautes de frappe (trigrammes, pg_trgm).
// La copie est tenue à jour par tranches (syncSearchIndex, toutes les 15 min) ; tant qu'elle n'est pas complète, ou si
// Neon ne répond pas, la recherche se fait comme avant dans les bases.

import { neon, kvGet, kvSet, logEvent } from './kvstore.js';
import { perDb, itemsWhereIds } from './shard.js';
import { mentionsBrand, brandNames, brandRules } from './synonyms.js';
import { describeImage } from './vision.js';
import { canonicalUrl } from './links.js';
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
  // Marques de chaque item (étiquettes calculées par Neon avec brand_rules) : recherche d'une marque instantanée.
  'CREATE TABLE IF NOT EXISTS brand_rules (name TEXT PRIMARY KEY, re TEXT NOT NULL)',
  'ALTER TABLE items_search ADD COLUMN IF NOT EXISTS brands TEXT[]',
  'CREATE INDEX IF NOT EXISTS items_search_brands ON items_search USING gin (brands)',
];

// Étiquettes de marque d'un item, calculées dans Neon à partir de son texte (x = ligne en cours d'insertion).
const TAGS = `coalesce((SELECT array_agg(r.name) FROM brand_rules r WHERE lower(coalesce(x.title_en,'') || ' ' || coalesce(x.title_zh,'') || ' ' || coalesce(x.shop_name,'')) ~ r.re), '{}')`;

// Deux projets Neon gratuits (0,5 Go chacun) : Weidian dans le 2e (NEON_URL_2), Taobao et 1688 dans le 1er. Sans
// NEON_URL_2, tout reste dans le 1er. Chaque recherche interroge les deux en même temps et fusionne.
export function neonParts(env) {
  return env.NEON_URL_2 ? [env, Object.assign(Object.create(env), { NEON_URL: env.NEON_URL_2, NEON_PART: 2 })] : [env];
}
const partFor = (parts, id) => (parts.length > 1 && String(id).startsWith('weidian:') ? parts[1] : parts[0]);
const suffix = (pe) => (pe.NEON_PART === 2 ? ':2' : '');

// Lignes regroupées par projet : [[env du projet, lignes], …] (projets sans ligne omis).
function byPart(env, rows, idOf = (r) => r.id) {
  const parts = neonParts(env);
  const map = new Map();
  for (const r of rows) {
    const pe = partFor(parts, idOf(r));
    if (!map.has(pe)) map.set(pe, []);
    map.get(pe).push(r);
  }
  return [...map];
}

// Même requête sur chaque projet ; un projet qui ne répond pas est sauté (null si aucun ne répond).
async function fromParts(env, run) {
  const out = await Promise.all(neonParts(env).map((pe) => run(pe).catch((err) => {
    console.log(`index de recherche (Neon ${pe.NEON_PART || 1})`, String(err).slice(0, 160));
    return null;
  })));
  const ok = out.filter(Boolean);
  return ok.length ? ok.flat() : null;
}

const schemaReady = new Map();
function ensureSchema(env) {
  const key = env.NEON_URL;
  if (!schemaReady.has(key)) {
    schemaReady.set(key, (async () => { for (const q of SCHEMA) await neon(env, q); await ensureRules(env); })()
      .catch((err) => { schemaReady.delete(key); throw err; }));
  }
  return schemaReady.get(key);
}

// Règles de marque (synonyms.js) recopiées dans un projet quand elles changent. true si elles viennent de changer.
const rulesVersion = (rules) => String(rules.map((r) => r.name + r.re).join('|').length) + ':' + rules.length;
async function ensureRules(pe) {
  const rules = brandRules();
  const version = rulesVersion(rules);
  if ((await kvGet(pe, `sidx:rules${suffix(pe)}`)) === version) return false;
  await neon(pe, 'DELETE FROM brand_rules');
  await neon(pe, 'INSERT INTO brand_rules (name, re) SELECT name, re FROM jsonb_to_recordset($1::jsonb) AS x(name TEXT, re TEXT)', [JSON.stringify(rules)]);
  await kvSet(pe, `sidx:rules${suffix(pe)}`, version);
  return true;
}

// Nom de chaque base du catalogue (pour sa position de copie).
const dbTag = (e, env) => (e.DB.isD1 ? 'd1' : env.DB2 && e.DB === env.DB2 ? 'db2' : 'db1');

// Toutes les 15 min : la tranche suivante de chaque base copiée dans Neon. Quand une base a été copiée en entier, on
// recommence (prix, popularité et nombre de QC mis à jour à chaque tour). Renvoie le nombre d'items copiés.
export async function syncSearchIndex(env) {
  if (!env.NEON_URL) return 0;
  for (const pe of neonParts(env)) await ensureSchema(pe);
  let copied = 0;
  for (const e of perDb(env)) {
    const tag = dbTag(e, env);
    // D'abord les nouveaux items (après le dernier déjà copié) : ils arrivent dans la recherche en 15 min, sans
    // attendre que le tour complet de la base les atteigne.
    const tail = Number(await kvGet(env, `sidx:tail:${tag}`)) || 0;
    if (tail) {
      const fresh = await copyRows(env, e, tail);
      copied += fresh.n;
      if (fresh.last) await kvSet(env, `sidx:tail:${tag}`, fresh.last);
    }
    let cursor = Number(await kvGet(env, `sidx:cursor:${tag}`)) || 0;
    // Tour complet (prix, popularité, QC à jour) au plus une fois par jour : chaque tour relit toute la base, ce qui a
    // épuisé le quota de lectures de D1 le 28/10. Entre deux tours, seulement les nouveaux items (ci-dessus).
    const lastDone = Number(await kvGet(env, `sidx:done:${tag}`)) || 0;
    if (!cursor && Date.now() - lastDone < 24 * 3600000) continue;
    for (let i = 0; i < PER_RUN - 1; i++) {
      const r = await copyRows(env, e, cursor);
      copied += r.n;
      if (r.last) cursor = r.last;
      if (r.last && r.last > tail) await kvSet(env, `sidx:tail:${tag}`, r.last);
      if (r.n < CHUNK) {
        // Fin de la base : un tour complet est fait, on recommence au début au prochain passage.
        await kvSet(env, `sidx:done:${tag}`, Date.now());
        cursor = 0;
        break;
      }
    }
    await kvSet(env, `sidx:cursor:${tag}`, cursor);
  }
  // Étiquettes de marque pas encore toutes calculées : un paquet à chaque passage.
  if (!(await tagsReady(env))) await syncBrandTags(env).catch((err) => console.log('étiquettes de marque', String(err).slice(0, 120)));
  return copied;
}

// Une tranche d'items (rowid > after) copiée dans l'index. { n, last }
async function copyRows(env, e, after) {
  const { results } = await e.DB.prepare(
    `SELECT rowid AS rid, id, title_en, title_zh, shop_name, shop_id, category, popularity, first_seen, price_cny,
            hidden, posted_count, qc_count, prev_price, price_changed_at
     FROM items WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  ).bind(after, CHUNK).all();
  if (!results.length) return { n: 0, last: null };
  for (const [pe, rows] of byPart(env, results)) await upsertRows(pe, rows.map(({ rid, ...x }) => x));
  return { n: results.length, last: results[results.length - 1].rid };
}

async function upsertRows(pe, rows) {
  await neon(pe, `INSERT INTO items_search (id, title_en, title_zh, shop_name, shop_id, category, popularity, first_seen, price,
       hidden, posted, qc, prev_price, price_changed_at, brands)
     SELECT id, title_en, title_zh, shop_name, shop_id, category, coalesce(popularity, 0), first_seen, price_cny,
       coalesce(hidden, 0), coalesce(posted_count, 0), coalesce(qc_count, 0), prev_price, price_changed_at, ${TAGS}
     FROM jsonb_to_recordset($1::jsonb) AS x(id TEXT, title_en TEXT, title_zh TEXT, shop_name TEXT, shop_id TEXT, category TEXT,
       popularity INTEGER, first_seen BIGINT, price_cny REAL, hidden SMALLINT, posted_count INTEGER, qc_count INTEGER,
       prev_price REAL, price_changed_at BIGINT)
     ON CONFLICT (id) DO UPDATE SET title_en = EXCLUDED.title_en, title_zh = EXCLUDED.title_zh, shop_name = EXCLUDED.shop_name,
       shop_id = EXCLUDED.shop_id, category = EXCLUDED.category, popularity = EXCLUDED.popularity, first_seen = EXCLUDED.first_seen,
       price = EXCLUDED.price, hidden = EXCLUDED.hidden, posted = EXCLUDED.posted, qc = EXCLUDED.qc,
       prev_price = EXCLUDED.prev_price, price_changed_at = EXCLUDED.price_changed_at, brands = EXCLUDED.brands`,
  [JSON.stringify(rows)]);
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
  // Jamais de produit pour adultes (titres repérés ; FinderQC les signale aussi à la synchro).
  const clauses = ['hidden = 0', "lower(coalesce(title_en, '')) !~ '(sex ?(doll|toy)s?|adult products?|vibrator|dildo|masturbat|inverted mold|erotic)'"];
  const binds = [];
  const p = (v) => { binds.push(v); return `$${binds.length}`; };
  for (const g of params.groups || []) {
    // Étiquettes de marque prêtes : la marque se cherche par étiquette (index) ou par la marque lue sur la photo, au
    // lieu de relire chaque titre.
    if (g.kind === 'brand' && params.tagged) {
      const names = brandNames(g);
      clauses.push(`(brands && ARRAY[${p(g.alt[0])}::text]${names.length ? ` OR brand IN (SELECT jsonb_array_elements_text(${p(JSON.stringify(names))}::jsonb))` : ''})`);
      continue;
    }
    const ors = [];
    const latin = [];
    for (const a of g.alt) {
      if (latinAlt(a)) {
        const spaced = a.includes(' ') ? [a.replace(/ /g, ''), a.replace(/ /g, '-')] : [];
        for (const form of new Set([a, `${a}s`, ...spaced])) latin.push(esc(form));
      } else if (!g.alt.some(latinAlt)) {
        // Mot chinois seul (sans équivalent latin) : cherché sans index. S'il a un nom latin, celui-ci suffit (titres
        // traduits en anglais) et la requête reste rapide (index de trigrammes).
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
// Étiquettes de marque prêtes ? (gardé 60 s en mémoire)
let tagMemo = null;
async function tagged(env) {
  if (tagMemo && Date.now() - tagMemo.at < 60000) return tagMemo.ok;
  tagMemo = { at: Date.now(), ok: await tagsReady(env).catch(() => false) };
  return tagMemo.ok;
}

// Résultats des deux projets fusionnés dans l'ordre demandé.
const byPopular = (a, b) => b.popularity - a.popularity || b.first_seen - a.first_seen;
const MERGE = {
  popular: byPopular,
  recent: (a, b) => b.first_seen - a.first_seen,
  price_asc: (a, b) => (a.price_cny ?? Infinity) - (b.price_cny ?? Infinity),
  price_desc: (a, b) => (b.price_cny ?? -Infinity) - (a.price_cny ?? -Infinity),
};
const merged = (rows, limit, sort = 'popular') => (rows ? rows.map(num).sort(MERGE[sort]).slice(0, limit) : null);

export async function indexSearch(env, params, money) {
  const w = neonWhere({ ...params, tagged: await tagged(env) }, money);
  const rows = await fromParts(env, (pe) => neon(pe, `SELECT ${COLS} FROM items_search ${w.sql} ORDER BY popularity DESC, first_seen DESC LIMIT 5000`, w.binds));
  return merged(rows, 5000);
}

// Fautes de frappe (« suprem hodie ») : items dont le texte contient un mot proche de chacun des mots cherchés
// (similarité de trigrammes). Seulement quand la recherche normale trouve trop peu. [] si rien.
export async function fuzzySearch(env, words, params, money) {
  const list = (words || []).filter((x) => x.length >= 3).slice(0, 4);
  if (!list.length) return [];
  const w = neonWhere({ ...params, groups: [] }, money);
  const conds = list.map((x) => { w.binds.push(x); return `$${w.binds.length} <% ${TXT}`; });
  const rows = await fromParts(env, (pe) => neon(pe,
    `SELECT ${COLS} FROM items_search ${w.sql} AND ${conds.join(' AND ')} ORDER BY popularity DESC, first_seen DESC LIMIT 200`, w.binds));
  return merged(rows, 200) || [];
}

// Toutes les 3 min : la marque des items populaires dont le titre ne cite aucune marque, lue sur leur photo (modèle de
// vision chez OVH, gratuit : les quotas d'IA du jour restent aux membres). Des plus vendus aux moins vendus.
// Renvoie le nombre d'items regardés.
const SCAN_PER_RUN = 6;
export async function scanBrands(env) {
  if (!env.NEON_URL || env.BRAND_SCAN === '0') return 0;
  for (const pe of neonParts(env)) await ensureSchema(pe);
  const rows = ((await fromParts(env, (pe) => neon(pe, `SELECT id, title_en, title_zh, shop_name, popularity FROM items_search
    WHERE brand_checked IS NULL AND hidden = 0 AND popularity >= 20 ORDER BY popularity DESC LIMIT 60`))) || [])
    .sort((a, b) => Number(b.popularity) - Number(a.popularity)).slice(0, 60);
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
      if (brand) await logEvent(env, 'brand', `${brand} · ${String(r.title_en || r.title_zh || r.id).slice(0, 60)}`).catch(() => {});
    }
    found.push({ id: r.id, brand });
  }
  const marks = [...named.map((id) => ({ id, brand: null })), ...found];
  for (const [pe, part] of byPart(env, marks)) {
    await neon(pe, `UPDATE items_search s SET brand = coalesce(nullif(x.brand, ''), s.brand), brand_checked = $2
      FROM jsonb_to_recordset($1::jsonb) AS x(id TEXT, brand TEXT) WHERE s.id = x.id`, [JSON.stringify(part), Date.now()]);
  }
  return found.length;
}

// Liste triée (catégorie, nouveautés, baisses de prix, prix…) dans l'index : jusqu'à 1 000 items. null si Neon ne
// répond pas.
const LIST_ORDER = {
  popular: 'popularity DESC, first_seen DESC',
  recent: 'first_seen DESC NULLS LAST',
  price_asc: 'price ASC NULLS LAST',
  price_desc: 'price DESC NULLS LAST',
};
export async function indexList(env, params, money) {
  const w = neonWhere({ ...params, tagged: await tagged(env) }, money);
  const sort = params.sort && LIST_ORDER[params.sort] ? params.sort : params.latest ? 'recent' : 'popular';
  const rows = await fromParts(env, (pe) => neon(pe, `SELECT ${COLS} FROM items_search ${w.sql} ORDER BY ${LIST_ORDER[sort]} LIMIT 1000`, w.binds));
  return merged(rows, 1000, sort);
}

// Fiches d'items tirées de l'index (quand les bases sont illisibles) : mêmes champs que la table items, sans photo.
export async function indexItems(env, ids) {
  if (!ids.length) return [];
  const rows = (await Promise.all(byPart(env, ids.slice(0, 500), (id) => id).map(([pe, part]) => neon(pe,
    `SELECT id, title_en, title_zh, shop_name, shop_id, category, popularity, first_seen, price, posted, qc, prev_price, price_changed_at
    FROM items_search WHERE hidden = 0 AND id IN (SELECT jsonb_array_elements_text($1::jsonb))`, [JSON.stringify(part)])))).flat();
  return rows.map((r) => {
    const [platform, itemId] = r.id.split(':');
    return { id: r.id, platform, item_id: itemId, url: canonicalUrl(platform, itemId), title_en: r.title_en, title_zh: r.title_zh,
      shop_name: r.shop_name, shop_id: r.shop_id, category: r.category, popularity: Number(r.popularity) || 0, first_seen: Number(r.first_seen) || null,
      price_cny: r.price == null ? null : Number(r.price), posted_count: Number(r.posted) || 0, qc_count: Number(r.qc) || 0,
      prev_price: r.prev_price == null ? null : Number(r.prev_price), price_changed_at: Number(r.price_changed_at) || null, image: null, hidden: 0 };
  });
}

// Produits FinderQC trouvés en direct → index de recherche tout de suite (titre, prix, ventes, QC, catégorie).
export async function indexUpsert(env, list) {
  const { finderKey } = await import('./qc.js');
  const { detectCategory } = await import('./categories.js');
  const rows = list.map((x) => ({ id: finderKey(x), title_en: x.enTitle || null, title_zh: x.originalTitle || null, category: detectCategory(x.enTitle || x.originalTitle || ''),
    popularity: Math.max(0, Number(x.oneYear) || 0), first_seen: Date.now(), price: x.cnPrice != null ? Number(x.cnPrice) : null, qc: Number(x.qcPhotosCount) || 0 }))
    .filter((r) => /^(weidian|taobao|1688):\d+$/.test(r.id));
  if (!rows.length) return 0;
  for (const [pe, part] of byPart(env, rows)) {
    await ensureSchema(pe);
    await neon(pe, `INSERT INTO items_search (id, title_en, title_zh, category, popularity, first_seen, price, qc, brands)
      SELECT id, title_en, title_zh, category, popularity, first_seen, price, qc, ${TAGS} FROM jsonb_to_recordset($1::jsonb)
        AS x(id TEXT, title_en TEXT, title_zh TEXT, shop_name TEXT, category TEXT, popularity INTEGER, first_seen BIGINT, price REAL, qc INTEGER)
      ON CONFLICT (id) DO NOTHING`, [JSON.stringify(part)]);
  }
  return rows.length;
}

// Règles de marque (synonyms.js) recopiées dans Neon quand elles changent, puis étiquettes des items sans étiquette
// (par paquets : après un changement de règles, toutes les étiquettes sont recalculées). Renvoie { rules, tagged, left }.
export async function syncBrandTags(env, batch = 4000) {
  let left = 0;
  for (const pe of neonParts(env)) {
    await ensureSchema(pe);
    if (await ensureRules(pe)) {
      await neon(pe, 'UPDATE items_search SET brands = NULL WHERE brands IS NOT NULL');
      await kvSet(env, 'sidx:tagged', '0');
    }
    await neon(Object.assign(Object.create(pe), { NEON_TIMEOUT: 25000 }), `UPDATE items_search x SET brands = ${TAGS}
      WHERE x.id IN (SELECT id FROM items_search WHERE brands IS NULL LIMIT ${Number(batch) || 4000})`);
    const [r] = await neon(pe, 'SELECT count(*) FILTER (WHERE brands IS NULL) AS left FROM items_search');
    left += Number(r.left);
  }
  if (!left) await kvSet(env, 'sidx:tagged', '1');
  return { rules: brandRules().length, left };
}

// Passage à deux projets : les items Weidian du 1er projet déplacés dans le 2e (marque lue sur la photo comprise), par
// paquets. Renvoie { moved, left }.
export async function moveToSecondPart(env, batch = 4000) {
  const parts = neonParts(env);
  if (parts.length < 2) return { moved: 0, left: 0, error: 'NEON_URL_2 manquant' };
  const [one, two] = parts;
  await ensureSchema(two);
  const rows = await neon(Object.assign(Object.create(one), { NEON_TIMEOUT: 25000 }),
    `SELECT id, title_en, title_zh, shop_name, shop_id, category, popularity, first_seen, price AS price_cny, hidden, posted AS posted_count,
       qc AS qc_count, prev_price, price_changed_at, brand, brand_checked FROM items_search WHERE id LIKE 'weidian:%' LIMIT ${Number(batch) || 4000}`);
  if (rows.length) {
    await upsertRows(Object.assign(Object.create(two), { NEON_TIMEOUT: 25000 }), rows.map(({ brand, brand_checked, ...x }) => x));
    const marks = rows.filter((r) => r.brand || r.brand_checked).map((r) => ({ id: r.id, brand: r.brand, at: r.brand_checked }));
    if (marks.length) {
      await neon(two, `UPDATE items_search s SET brand = x.brand, brand_checked = x.at
        FROM jsonb_to_recordset($1::jsonb) AS x(id TEXT, brand TEXT, at BIGINT) WHERE s.id = x.id`, [JSON.stringify(marks)]);
    }
    await neon(one, 'DELETE FROM items_search WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))', [JSON.stringify(rows.map((r) => r.id))]);
  }
  const [r] = await neon(one, "SELECT count(*) AS n FROM items_search WHERE id LIKE 'weidian:%'");
  return { moved: rows.length, left: Number(r.n) };
}

export async function tagsReady(env) {
  return (await kvGet(env, 'sidx:tagged')) === '1';
}
