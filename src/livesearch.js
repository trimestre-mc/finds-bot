// Recherche en direct dans tout le catalogue FinderQC (avec l'accord de son propriétaire) : une recherche du bot
// interroge aussi FinderQC, et les produits trouvés sont enregistrés dans la base avant le classement habituel.
// Tout le catalogue est ainsi cherchable sans attendre l'indexation complète ; seuls les produits trouvés sont
// écrits (au plus LIVE_RESULTS par recherche, et un produit déjà connu et inchangé n'écrit rien).

import { finderItemStatements, finderKey } from './qc.js';
import { itemEnv, batchByDb } from './shard.js';
import { canonicalUrl } from './links.js';

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
// toIndex : les produits trouvés vont aussi tout de suite dans l'index de recherche (sinon visibles 15 min plus tard).
export async function addLiveResults(env, params, money, toIndex = false) {
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
    // Chaque produit dans la base qui lui revient (voir shard.js).
    await batchByDb(list.flatMap((x) => {
      const e = itemEnv(env, finderKey(x));
      return finderItemStatements(e, x, now).map((st) => [e.DB, st]);
    })).catch((err) => console.log('recherche FinderQC (base)', String(err).slice(0, 100)));
    if (toIndex && list.length) {
      const { indexUpsert } = await import('./searchindex.js');
      await indexUpsert(env, list).catch((err) => console.log('recherche FinderQC (index)', String(err).slice(0, 100)));
    }
    return list.length;
  } catch (err) {
    console.log('recherche FinderQC', String(err).slice(0, 120));
    return 0;
  }
}

// Fiche d'un produit chez FinderQC (titre, prix, photo, ventes, QC), sous la forme d'un item du catalogue.
// Sert quand l'item n'est pas (encore) dans la base : comparer, suivre son prix. null si inconnu.
export async function finderItem(key) {
  const [platform, itemId] = String(key || '').split(':');
  const url = canonicalUrl(platform, itemId);
  if (!url) return null;
  const res = await fetch(`https://server.finderqc.com/api/spu/webSpuInfo?id=${encodeURIComponent(itemId)}&page=1&pageSize=1`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`FinderQC ${res.status}`);
  const data = await res.json();
  const s = data && data.code === 0 && data.data && data.data.spuInfo;
  if (!s) return null;
  const image = [s.originalThubnaiUrl, s.picUrl].find((u) => /^https:\/\//.test(u || '')) || null;
  return { id: key, platform, item_id: itemId, url, title_en: s.enTitle || s.originalTitle || null, price_cny: Number(s.cnPrice) || null,
    image, popularity: Number(s.oneYear) || 0, qc_count: Number(s.qcPhotosCount) || 0 };
}
