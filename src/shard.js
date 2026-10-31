// Catalogue partagé entre deux bases gratuites (deux comptes Turso) : chaque base a son propre quota.
// Règle fixe : les items Weidian vivent dans la 1re base (env.DB), Taobao et 1688 dans la 2e (env.DB2).
// Dans chaque base : ses items et sa file de liens (link_queue, Weidian seulement en pratique), plus ses compteurs
// (settings : budgets, curseurs, lectures du mois). Tout le reste (boutiques, posts, réglages, recherches) reste
// dans la 1re base.
// Sans DB2, tout reste dans env.DB : le comportement est exactement celui d'une seule base.

// Toutes les bases du catalogue.
export function itemDbs(env) {
  const main = env.MAIN || env.DB;
  return env.DB2 ? [main, env.DB2] : [main];
}

const SECOND = /^(taobao|1688):/;

// Base d'un item (clé « plateforme:numéro » ; un numéro seul est un item Weidian).
export function itemDb(env, key) {
  return env.DB2 && SECOND.test(String(key || '')) ? env.DB2 : (env.MAIN || env.DB);
}

// Même environnement, avec une autre base en env.DB (les tâches écrites pour une seule base marchent telles quelles).
// env.MAIN garde la 1re base pour ce qui n'existe qu'en un exemplaire (réglages, boutiques, quota d'IA).
export function onDb(env, db) {
  return Object.assign(Object.create(env), { DB: db, MAIN: env.MAIN || env.DB });
}

// Un environnement par base du catalogue.
export function perDb(env) {
  return itemDbs(env).map((db) => onDb(env, db));
}

// Environnement de la base d'un item.
export function itemEnv(env, key) {
  return onDb(env, itemDb(env, key));
}

// Clés regroupées par base : [[db, [clés…]], …] (bases sans clé omises).
export function groupByDb(env, keys) {
  const map = new Map();
  for (const k of keys) {
    const db = itemDb(env, k);
    if (!map.has(db)) map.set(db, []);
    map.get(db).push(k);
  }
  return [...map];
}

// Même requête sur chaque base, résultats mis bout à bout.
// Une base aux lectures bloquées (quota Turso du mois) est sautée : les autres répondent quand même.
export async function allRows(env, sql, ...binds) {
  const dbs = itemDbs(env);
  const parts = await Promise.all(dbs.map((db) => db.prepare(sql).bind(...binds).all().catch((err) => {
    if (dbs.length < 2 || !/reads are blocked|forbidden/i.test(String(err))) throw err;
    console.log('base sautée (lectures bloquées)', String(err).slice(0, 80));
    return { results: [] };
  })));
  return parts.flatMap((p) => p.results);
}

// Somme d'un COUNT(*) AS n sur chaque base.
export async function countAll(env, sql, ...binds) {
  const rows = await allRows(env, sql, ...binds);
  return rows.reduce((s, r) => s + (Number(r.n) || 0), 0);
}

// Items par clés, depuis la bonne base (une requête par base). where : condition SQL en plus.
export async function itemsWhereIds(env, ids, columns = '*', where = '') {
  if (!ids.length) return [];
  const parts = await Promise.all(groupByDb(env, ids).map(([db, keys]) => db
    .prepare(`SELECT ${columns} FROM items WHERE ${where ? `${where} AND ` : ''}id IN (${keys.map(() => '?').join(',')})`)
    .bind(...keys).all()));
  return parts.flatMap((p) => p.results);
}

// Un item par sa clé.
// Base illisible (quota du mois) : la fiche vient de l'index de recherche Neon (sans photo), sinon null.
export async function itemById(env, key) {
  try {
    return await itemDb(env, key).prepare('SELECT * FROM items WHERE id = ?').bind(key).first();
  } catch (err) {
    if (!/reads are blocked|forbidden/i.test(String(err))) throw err;
    const { indexItems } = await import('./searchindex.js');
    return (await indexItems(env, [key]).catch(() => []))[0] || null;
  }
}

// Lots par base : statements = [[db, stmt], …]. Renvoie [[db, résultats], …] (lots de 100 au plus).
export async function batchByDb(statements) {
  const map = new Map();
  for (const [db, st] of statements) {
    if (!map.has(db)) map.set(db, []);
    map.get(db).push(st);
  }
  const out = [];
  for (const [db, list] of map) {
    const results = [];
    try {
      for (let i = 0; i < list.length; i += 100) results.push(...await db.batch(list.slice(i, i + 100)));
    } catch (err) {
      // Base aux lectures bloquées (quota du mois) : son lot est sauté, les autres bases sont quand même écrites.
      if (map.size < 2 || !/reads are blocked|forbidden/i.test(String(err))) throw err;
      console.log('lot sauté (lectures bloquées)', String(err).slice(0, 100));
      while (results.length < list.length) results.push({ results: [], meta: { rows_written: 0, skipped: true } });
    }
    out.push([db, results]);
  }
  return out;
}

// Items d'une boutique retirée ou bannie, dans chaque base (sauf ceux ajoutés à la main).
export async function deleteShopItems(env, shopId) {
  await Promise.all(itemDbs(env).map((db) => db.prepare('DELETE FROM items WHERE shop_id = ? AND manual = 0').bind(shopId).run()));
}
