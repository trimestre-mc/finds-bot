// Stockages gratuits en plus de la base du catalogue, pour que l'indexation ne puisse plus bloquer le bot :
// - Upstash Redis (500 000 commandes/mois, UPSTASH_URL + UPSTASH_TOKEN) : petits compteurs qui écrivent sans arrêt
//   (connexion Discord active, quotas d'IA du jour, pause de Groq, durée moyenne d'une analyse) ;
// - Neon Postgres (NEON_URL, aucune limite de lignes lues ou écrites) : cache des recherches et des analyses IA.
// Chaque fonction renvoie undefined si le service manque ou ne répond pas : l'appelant reprend alors la base (D1/Turso).

export const hasRedis = (env) => !!(env.UPSTASH_URL && env.UPSTASH_TOKEN);

// Commandes Redis en un aller-retour (/pipeline). Renvoie les résultats, ou undefined en cas d'échec.
async function pipeline(env, cmds) {
  if (!hasRedis(env)) return undefined;
  try {
    const res = await fetch(`${env.UPSTASH_URL.replace(/\/$/, '')}/pipeline`, {
      method: 'POST', signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    const out = await res.json();
    if (out.some((r) => r.error)) throw new Error(`Upstash ${out.find((r) => r.error).error}`);
    return out.map((r) => r.result);
  } catch (err) {
    console.log('upstash', String(err).slice(0, 120));
    return undefined;
  }
}

export async function kvGet(env, key) {
  const r = await pipeline(env, [['GET', key]]);
  return r === undefined ? undefined : r[0];
}

// ttl en secondes (facultatif).
export async function kvSet(env, key, value, ttl = 0) {
  const r = await pipeline(env, [ttl ? ['SET', key, String(value), 'EX', String(ttl)] : ['SET', key, String(value)]]);
  return r !== undefined;
}

const today = () => new Date().toISOString().slice(0, 10);

// Compteur du jour (remis à zéro chaque jour UTC) : ajoute n et renvoie le nouveau total.
export async function dayAdd(env, name, n = 1) {
  const key = `${name}:${today()}`;
  // Toujours en décimal : un compteur qui a reçu une fois 0,5 refuserait ensuite tout INCRBY entier (budgets sous-comptés).
  const r = await pipeline(env, [['INCRBYFLOAT', key, String(n)], ['EXPIRE', key, '172800']]);
  return r === undefined ? undefined : Number(r[0]);
}

export async function dayGet(env, name) {
  const v = await kvGet(env, `${name}:${today()}`);
  return v === undefined ? undefined : Number(v || 0);
}

// ---------------------------------------------------------------- Cache (Neon, sinon la base)

let ready = null;

export async function neon(env, query, params = []) {
  const url = new URL(env.NEON_URL.replace(/^postgres(ql)?:/, 'https:'));
  const res = await fetch(`https://${url.hostname}/sql`, {
    method: 'POST', signal: AbortSignal.timeout(env.NEON_TIMEOUT || 8000),
    headers: { 'Neon-Connection-String': env.NEON_URL, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) throw new Error(`Neon ${res.status} ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).rows || [];
}

// Table du cache créée seulement si elle manque (pas de CREATE à chaque démarrage du Worker : ~170 ms par recherche).
const neonReady = (env) => !!env.NEON_URL;

async function cacheQuery(env, query, params) {
  try {
    return await neon(env, query, params);
  } catch (err) {
    if (!/relation "cache" does not exist/i.test(String(err))) throw err;
    await neon(env, 'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, ids TEXT NOT NULL, at BIGINT NOT NULL)');
    return neon(env, query, params);
  }
}

// { ids, at } ou null.
export async function cacheGet(env, key) {
  if (neonReady(env)) {
    try {
      const rows = await cacheQuery(env, 'SELECT ids, at FROM cache WHERE key = $1', [key]);
      return rows[0] ? { ids: rows[0].ids, at: Number(rows[0].at) } : null;
    } catch (err) { console.log('neon', String(err).slice(0, 160)); }
  }
  return env.DB.prepare('SELECT ids, at FROM search_cache WHERE key = ?').bind(key).first().catch(() => null);
}

export async function cacheSet(env, key, ids) {
  if (neonReady(env)) {
    try {
      await cacheQuery(env, 'INSERT INTO cache (key, ids, at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET ids = EXCLUDED.ids, at = EXCLUDED.at',
        [key, ids, Date.now()]);
      return;
    } catch (err) { console.log('neon', String(err).slice(0, 160)); }
  }
  await env.DB.prepare('INSERT OR REPLACE INTO search_cache (key, ids, at) VALUES (?, ?, ?)').bind(key, ids, Date.now()).run().catch(() => {});
}

// Vide le cache (tout, ou les entrées plus vieilles que olderMs, hors analyses IA gardées 30 jours).
export async function cacheClear(env, olderMs = 0) {
  if (neonReady(env)) {
    await (olderMs
      ? cacheQuery(env, "DELETE FROM cache WHERE at < $1 AND key NOT LIKE 'aiqc:%'", [Date.now() - olderMs])
      : cacheQuery(env, "DELETE FROM cache WHERE key NOT LIKE 'aiqc:%'")).catch((err) => console.log('neon', String(err).slice(0, 160)));
  }
  await (olderMs
    ? env.DB.prepare('DELETE FROM search_cache WHERE at < ?').bind(Date.now() - olderMs)
    : env.DB.prepare('DELETE FROM search_cache')).run().catch(() => {});
}

// ---------------------------------------------------------------- Verrous et limites (Upstash)

// Verrou d'un message de salon : true la 1re fois, false s'il est déjà pris (jamais deux réponses au même message,
// même si la base refuse les écritures), undefined si Upstash ne répond pas.
export async function lockMessage(env, id) {
  const r = await pipeline(env, [['SET', `msg:${id}`, '1', 'NX', 'EX', '172800']]);
  return r === undefined ? undefined : r[0] === 'OK';
}

// Limites par membre : rules = [{ s: durée en secondes, max }]. Renvoie { ok: true } ou { ok: false, until, rule }
// (until : fin de la fenêtre dépassée, en ms). Sans Upstash : toujours ok. Le propriétaire du bot n'a pas de limite.
export async function rateLimit(env, scope, userId, rules) {
  if (!userId || (env.AGENTS_OWNER_ID && userId === env.AGENTS_OWNER_ID)) return { ok: true };
  const now = Math.floor(Date.now() / 1000);
  const keys = rules.map((r) => `rl:${scope}:${userId}:${r.s}:${Math.floor(now / r.s)}`);
  const r = await pipeline(env, keys.flatMap((k, i) => [['INCR', k], ['EXPIRE', k, String(rules[i].s + 5)]]));
  if (r === undefined) return { ok: true };
  for (const [i, rule] of rules.entries()) {
    if (Number(r[i * 2]) > rule.max) return { ok: false, until: (Math.floor(now / rule.s) + 1) * rule.s * 1000, rule };
  }
  return { ok: true };
}


// Délais choisis (par membre) :
// - analyse IA des QC (coûteuse en quota d'IA) : 1 toutes les 20 s, 5 par heure, 15 par jour ;
// - recherche par image (FinderQC, qui limite vite) : 1 toutes les 10 s, 30 par heure.
export const LIMITS = {
  aiqc: [{ s: 20, max: 1 }, { s: 3600, max: 5 }, { s: 86400, max: 15 }],
  image: [{ s: 10, max: 1 }, { s: 3600, max: 30 }],
  // Recherches et fenêtres QC (Neon, FinderQC en direct) : large pour un membre, mais un spam ne sature plus le bot.
  find: [{ s: 3, max: 1 }, { s: 60, max: 12 }, { s: 3600, max: 150 }],
  qc: [{ s: 2, max: 1 }, { s: 60, max: 15 }, { s: 3600, max: 200 }],
};

// Texte d'attente : « prochaine dans 3 minutes » (horodatage Discord qui se met à jour tout seul).
export function limitText(lim, what, icon = '⏱️') {
  const per = lim.rule.s >= 86400 ? 'par jour' : lim.rule.s >= 3600 ? 'par heure' : lim.rule.s >= 60 ? 'par minute' : null;
  const next = `<t:${Math.ceil(lim.until / 1000)}:R>`;
  return per
    ? `${icon} **Limite atteinte** : ${lim.rule.max} ${what} ${per} et par membre. Prochaine demande possible ${next}.`
    : `${icon} **Demande précédente en cours de traitement.** Nouvelle demande possible ${next}.`;
}

// ---------------------------------------------------------------- Journal d'activité (dashboard)

// Événement du bot (analyse IA, recherche, conversion, erreur…) : gardé dans les 300 derniers, et compté par jour.
export async function logEvent(env, type, text) {
  if (!hasRedis(env)) return;
  const day = new Date().toISOString().slice(0, 10);
  await pipeline(env, [
    ['LPUSH', 'events', JSON.stringify({ at: Date.now(), type, text: String(text || '').slice(0, 160) })],
    ['LTRIM', 'events', '0', '299'],
    ['INCR', `stat:${type}:${day}`], ['EXPIRE', `stat:${type}:${day}`, '1209600'],
  ]);
}

// Derniers événements et compteurs des 7 derniers jours par type.
export async function readActivity(env, types) {
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const cmds = [['LRANGE', 'events', '0', '79'], ...types.flatMap((t) => days.map((d) => ['GET', `stat:${t}:${d}`]))];
  const r = await pipeline(env, cmds);
  if (!r) return null;
  const events = (r[0] || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  const stats = Object.fromEntries(types.map((t, i) => [t, days.map((d, j) => ({ day: d, n: Number(r[1 + i * days.length + j]) || 0 })).reverse()]));
  return { events, stats };
}

// Plusieurs clés d'un coup (dashboard).
export async function kvMany(env, keys) {
  const r = await pipeline(env, keys.map((k) => ['GET', k]));
  return r ? Object.fromEntries(keys.map((k, i) => [k, r[i]])) : {};
}

// Verrou court (ttl en secondes) : true si pris, false s'il est déjà pris, undefined sans Upstash.
export async function kvLock(env, key, ttl) {
  const r = await pipeline(env, [['SET', key, String(Date.now()), 'NX', 'EX', String(ttl)]]);
  return r === undefined ? undefined : r[0] === 'OK';
}

export async function kvDel(env, key) {
  await pipeline(env, [['DEL', key]]);
}

// FinderQC limite les requêtes du bot (429) : les membres passent avant la synchro du catalogue, mise en pause 10 min.
export async function finderBusy(env) {
  await kvSet(env, 'fqc:busy', Date.now() + 600000, 700);
}

export async function finderPaused(env) {
  return Number(await kvGet(env, 'fqc:busy')) > Date.now();
}

// Plusieurs commandes Redis en un aller-retour (pour les modules qui en ont besoin, ex. pub.js). undefined si échec.
export const redis = (env, cmds) => pipeline(env, cmds);
