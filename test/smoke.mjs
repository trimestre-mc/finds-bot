// Contrôle du bot en production (test de nuit sur GitHub) : services, index de recherche et une vraie recherche.
// Le test de bout en bout complet (test/e2e.mjs) se lance en local : sur GitHub, Weidian bloque les adresses des
// machines et le Worker local s'y arrête.
// Usage : WORKER_URL=… INDEXER_SECRET=… node test/smoke.mjs

const WORKER = (process.env.WORKER_URL || '').replace(/\/$/, '');
const SECRET = process.env.INDEXER_SECRET || '';
const api = (path) => fetch(WORKER + path, { headers: { Authorization: `Bearer ${SECRET}` }, signal: AbortSignal.timeout(60000) })
  .then((r) => r.json()).catch((err) => ({ error: String(err) }));

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const self = await api('/api/self-test');
check('bot en ligne', self.ok === true, self.error || '');

const stores = await api('/api/stores-check');
check('Upstash répond', stores.upstash === true);
check('Neon répond', stores.neon === true);
check('connexion Discord active (signal de moins de 10 min)', Date.now() - Number(stores.gatewayAlive || 0) < 10 * 60000,
  stores.gatewayAlive ? `il y a ${Math.round((Date.now() - Number(stores.gatewayAlive)) / 60000)} min` : 'aucun signal');

const index = await api('/api/searchindex');
check('index de recherche prêt', index.ready === true, `${index.n || 0} articles, ${index.size || '?'}`);
check('index : au moins 400 000 articles', Number(index.n) >= 400000, String(index.n));
const lastCopy = Math.max(0, ...Object.values(index.state || {}).map((s) => Number(s && s.done) || 0));
check('index : dernière copie complète de moins de 2 jours', Date.now() - lastCopy < 2 * 86400000);

for (const q of ['jordan 4', 'bape hoodie', 'lv bag']) {
  const t = Date.now();
  const r = await fetch(`${WORKER}/api/search-preview?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${SECRET}` }, signal: AbortSignal.timeout(60000) })
    .then((x) => x.json()).catch((err) => ({ error: String(err) }));
  check(`recherche « ${q} »`, Number(r.count) >= 20, `${r.count ?? r.error} résultats en ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

console.log(failures.length ? `\n${failures.length} échec(s)` : '\nTout est OK');
process.exit(failures.length ? 1 : 0);
