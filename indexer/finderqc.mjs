// QC des agents via l'API FinderQC (avec l'accord de son propriétaire) : nombre de photos, aperçu,
// et items similaires qui ont des QC (nouvelles découvertes). Rythme lent et identifiant clair du bot.

const API = 'https://server.finderqc.com/api/spu/webSpuInfo';
const UA = 'finds-bot/1.0 (+https://github.com/trimestre-mc/finds-bot)';
const DELAY_MS = 1200;
const PLATFORMS = { Weidian: 'weidian', Taobao: 'taobao', Ali1688: '1688' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spuInfo(itemId) {
  const res = await fetch(`${API}?id=${encodeURIComponent(itemId)}&page=1&pageSize=12`, { headers: { 'User-Agent': UA } });
  if (res.status === 429 || res.status === 403) throw new Error(`FinderQC refuse (${res.status})`);
  if (!res.ok) throw new Error(`FinderQC ${res.status}`);
  const data = await res.json();
  return data && data.code === 0 && data.data ? data.data.spuInfo : null;
}

// api(chemin, corps) interroge le Worker. Renvoie le nombre d'items vérifiés.
export async function collectQc(api, log = console.log, budgetMs = 15 * 60 * 1000) {
  const started = Date.now();
  const { items: keys } = await api('/api/indexer/qc-needed', { limit: 600 });
  if (!keys.length) return 0;
  log(`📸 ${keys.length} items à vérifier pour les QC`);
  let results = [];
  let similar = [];
  let done = 0;
  let withQc = 0;
  for (const key of keys) {
    if (Date.now() - started > budgetMs) { log('📸 temps écoulé, la suite au prochain passage'); break; }
    const itemId = key.split(':')[1];
    try {
      const s = await spuInfo(itemId);
      const preview = s ? (s.spuQcName || []).flatMap((b) => (b.spuImg || []).map((i) => i.url)).slice(0, 8) : [];
      const count = s ? Number(s.qcPhotosCount) || 0 : 0;
      if (count) withQc++;
      results.push({ key, count, preview });
      for (const x of (s && s.similarSpuList) || []) {
        const platform = PLATFORMS[x.mallType];
        const id = x.originItemId || x.itemId;
        if (!platform || !/^\d{6,14}$/.test(String(id)) || !(x.qcPhotosCount > 0)) continue;
        similar.push({ platform, id: String(id), title: x.enTitle || x.originalTitle, price: x.cnPrice, image: x.originalThubnaiURL || x.picUrl, sold: x.oneYear || 0 });
      }
    } catch (err) {
      log(`📸 ${key} : ${err.message}`);
      if (/refuse/.test(err.message)) break;
    }
    done++;
    if (results.length >= 50) await api('/api/indexer/qc', { items: results.splice(0) });
    if (similar.length >= 200) await api('/api/indexer/jadeship', { items: similar.splice(0) });
    await sleep(DELAY_MS);
  }
  if (results.length) await api('/api/indexer/qc', { items: results });
  if (similar.length) await api('/api/indexer/jadeship', { items: similar });
  log(`📸 QC vérifiées pour ${done} items (${withQc} en ont)`);
  return done;
}
