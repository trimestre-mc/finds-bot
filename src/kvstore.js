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
  const op = Number.isInteger(n) ? ['INCRBY', key, String(n)] : ['INCRBYFLOAT', key, String(n)];
  const r = await pipeline(env, [op, ['EXPIRE', key, '172800']]);
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

async function neonReady(env) {
  if (!env.NEON_URL) return false;
  ready = ready || neon(env, 'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, ids TEXT NOT NULL, at BIGINT NOT NULL)')
    .then(() => true).catch((err) => { console.log('neon', String(err).slice(0, 160)); ready = null; return false; });
  return ready;
}

// { ids, at } ou null.
export async function cacheGet(env, key) {
  if (await neonReady(env)) {
    try {
      const rows = await neon(env, 'SELECT ids, at FROM cache WHERE key = $1', [key]);
      return rows[0] ? { ids: rows[0].ids, at: Number(rows[0].at) } : null;
    } catch (err) { console.log('neon', String(err).slice(0, 160)); }
  }
  return env.DB.prepare('SELECT ids, at FROM search_cache WHERE key = ?').bind(key).first().catch(() => null);
}

export async function cacheSet(env, key, ids) {
  if (await neonReady(env)) {
    try {
      await neon(env, 'INSERT INTO cache (key, ids, at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET ids = EXCLUDED.ids, at = EXCLUDED.at',
        [key, ids, Date.now()]);
      return;
    } catch (err) { console.log('neon', String(err).slice(0, 160)); }
  }
  await env.DB.prepare('INSERT OR REPLACE INTO search_cache (key, ids, at) VALUES (?, ?, ?)').bind(key, ids, Date.now()).run().catch(() => {});
}

// Vide le cache (tout, ou les entrées plus vieilles que olderMs, hors analyses IA gardées 30 jours).
export async function cacheClear(env, olderMs = 0) {
  if (await neonReady(env)) {
    await (olderMs
      ? neon(env, "DELETE FROM cache WHERE at < $1 AND key NOT LIKE 'aiqc:%'", [Date.now() - olderMs])
      : neon(env, "DELETE FROM cache WHERE key NOT LIKE 'aiqc:%'")).catch((err) => console.log('neon', String(err).slice(0, 160)));
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
};

// Texte d'attente : « prochaine dans 3 minutes » (horodatage Discord qui se met à jour tout seul).
export function limitText(lim, what, icon = '⏱️') {
  const per = lim.rule.s >= 86400 ? 'par jour' : lim.rule.s >= 3600 ? 'par heure' : null;
  const next = `<t:${Math.ceil(lim.until / 1000)}:R>`;
  return per
    ? `${icon} **Tu enchaînes !** C'est ${lim.rule.max} ${what} ${per} max. Tu pourras recommencer ${next}.`
    : `${icon} **Une seconde !** Laisse-moi finir la précédente, tu pourras relancer ${next}.`;
}
