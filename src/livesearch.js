// Recherche en direct dans tout le catalogue FinderQC (avec l'accord de son propriétaire) : une recherche du bot
// interroge aussi FinderQC, et les produits trouvés sont enregistrés dans la base avant le classement habituel.
// Tout le catalogue est ainsi cherchable sans attendre l'indexation complète ; seuls les produits trouvés sont
// écrits (au plus LIVE_RESULTS par recherche, et un produit déjà connu et inchangé n'écrit rien).

import { finderItemStatements } from './qc.js';

const API = 'https://server.finderqc.com/api/spu/webSpuList';
const UA = 'finds-bot/1.0 (+https://github.com/trimestre-mc/finds-bot)';
export const LIVE_RESULTS = 60;
const TIMEOUT_MS = 6000;

// Requête envoyée à FinderQC : le premier équivalent latin de chaque mot (« chaussette nike » → « socks nike »),
// car leurs titres sont en anglais.
export function liveQuery(groups) {
  return (groups || [])
    .map((g) => g.alt.find((a) => /^[a-z0-9' -]+$/.test(a)))
    .filter(Boolean)
    .join(' ')
    .slice(0, 80);
}

export async function finderSearch(query, { maxCny = null, minCny = null } = {}) {
  const qs = new URLSearchParams({ search: query, page: '1', pageSize: String(LIVE_RESULTS) });
  if (minCny != null) qs.set('minPrice', minCny.toFixed(2));
  if (maxCny != null) qs.set('maxPrice', maxCny.toFixed(2));
  const res = await fetch(`${API}?${qs}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`FinderQC ${res.status}`);
  const data = await res.json();
  if (!data || data.code !== 0 || !data.data) throw new Error('FinderQC : réponse inattendue');
  return data.data.list || [];
}

// Cherche chez FinderQC et enregistre les produits trouvés. Ne fait jamais échouer la recherche du bot.
export async function addLiveResults(env, params, money) {
  if (env.LIVE_SEARCH === '0') return 0; // banc de test : base de test figée
  const query = liveQuery(params.groups);
  if (!query) return 0;
  const rate = money && money.rate ? money.rate : null;
  try {
    const list = await finderSearch(query, {
      maxCny: params.max != null && rate ? params.max / rate : null,
      minCny: params.min != null && rate ? params.min / rate : null,
    });
    const now = Date.now();
    const stmts = list.flatMap((x) => finderItemStatements(env, x, now));
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return list.length;
  } catch (err) {
    console.log('recherche FinderQC', String(err).slice(0, 120));
    return 0;
  }
}
