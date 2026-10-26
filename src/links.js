// Analyse des liens Weidian / Taobao / 1688 et construction des liens d'agents.

// Lien de boutique Weidian -> userid
export function parseWeidianShop(input) {
  const s = input.trim();
  let m = s.match(/[?&](?:userid|userId|shopId|shop_id)=(\d{5,15})/);
  if (m) return m[1];
  m = s.match(/shop(\d{5,15})\.v\.weidian\.com/);
  if (m) return m[1];
  m = s.match(/weidian\.com\/s\/(\d{5,15})/);
  if (m) return m[1];
  if (/^\d{5,15}$/.test(s)) return s;
  return null;
}

// Lien d'item -> { platform, itemId, url } (url = lien canonique d'origine)
export function parseItemLink(input) {
  const s = decodeURIComponent(input.trim());
  let m = s.match(/weidian\.com\/item\.html\?[^#]*?itemI[dD]=(\d+)/);
  if (m) return { platform: 'weidian', itemId: m[1], url: `https://weidian.com/item.html?itemID=${m[1]}` };
  m = s.match(/(?:item\.taobao\.com|detail\.tmall\.com)\/item\.htm\?[^#]*?\bid=(\d+)/);
  if (m) return { platform: 'taobao', itemId: m[1], url: `https://item.taobao.com/item.htm?id=${m[1]}` };
  m = s.match(/detail\.1688\.com\/offer\/(\d+)/);
  if (m) return { platform: '1688', itemId: m[1], url: `https://detail.1688.com/offer/${m[1]}.html` };
  return null;
}

export function canonicalUrl(platform, itemId) {
  if (platform === 'weidian') return `https://weidian.com/item.html?itemID=${itemId}`;
  if (platform === 'taobao') return `https://item.taobao.com/item.htm?id=${itemId}`;
  if (platform === '1688') return `https://detail.1688.com/offer/${itemId}.html`;
  return null;
}

function normPlatform(p) {
  const s = String(p).toLowerCase();
  if (s === 'wd' || s === 'weidian') return 'weidian';
  if (s === 'tb' || s === 'taobao' || s === 'tmall') return 'taobao';
  if (s === '1688' || s === 'ali_1688' || s === 'alibaba') return '1688';
  return null;
}

// Tous les items cités dans un texte (liens directs ou liens d'agents), sans doublon, dans l'ordre.
export function extractItemRefs(text) {
  let s = String(text || '');
  for (let i = 0; i < 3; i++) {
    try { const n = decodeURIComponent(s.replace(/\+/g, ' ')); if (n === s) break; s = n; } catch { break; }
  }
  const found = [];
  const add = (platform, id, at) => { const p = normPlatform(platform); if (p && id) found.push({ platform: p, itemId: id, at }); };
  const P = '(weidian|taobao|tmall|1688|ali_1688|wd|tb)';
  for (const m of s.matchAll(/weidian\.com\/item\.html\?[^\s"'<>]*?itemI[dD]=(\d{6,14})/g)) add('weidian', m[1], m.index);
  for (const m of s.matchAll(/(?:item\.taobao\.com|detail\.tmall\.com|world\.taobao\.com)\/item\.htm\?[^\s"'<>]*?\bid=(\d{6,14})/g)) add('taobao', m[1], m.index);
  for (const m of s.matchAll(/detail\.1688\.com\/offer\/(\d{6,14})/g)) add('1688', m[1], m.index);
  for (const m of s.matchAll(new RegExp(`/(?:goods|product|products|item)/${P}/(\\d{6,14})`, 'gi'))) add(m[1], m[2], m.index);
  for (const m of s.matchAll(new RegExp(`[?&](?:id|itemId|itemID|goodsId|goods_id)=(\\d{6,14})[^\\s"'<>]*?[?&](?:shop_type|platform|channel|source|shopType)=${P}\\b`, 'gi'))) add(m[2], m[1], m.index);
  for (const m of s.matchAll(new RegExp(`[?&](?:shop_type|platform|channel|source|shopType)=${P}[^\\s"'<>]*?[?&](?:id|itemId|itemID|goodsId|goods_id)=(\\d{6,14})`, 'gi'))) add(m[1], m[2], m.index);
  const seen = new Set();
  return found.sort((a, b) => a.at - b.at).filter((r) => {
    const k = `${r.platform}:${r.itemId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(({ platform, itemId }) => ({ platform, itemId, url: canonicalUrl(platform, itemId) }));
}

// Agents préréglés : il suffit de donner son code d'affiliation.
// Formats vérifiés sur les sites (BBDBuy garde inviteCode même s'il redirige vers la connexion).
export const AGENT_PRESETS = {
  bbdbuy: { name: 'BBDBuy', template: 'https://www.bbdbuy.com/goods/{PLATFORM}/{id}?inviteCode={code}' },
  kakobuy: { name: 'Kakobuy', template: 'https://www.kakobuy.com/item/details?url={url}&affcode={code}' },
};

export function isValidCode(code) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(code);
}

export function presetTemplate(presetKey, code) {
  const preset = AGENT_PRESETS[presetKey];
  return preset ? preset.template.replaceAll('{code}', encodeURIComponent(code)) : null;
}

// Remplit le modèle d'un agent pour un item.
export function buildAgentLink(template, item) {
  return template
    .replaceAll('{url}', encodeURIComponent(item.url))
    .replaceAll('{url_raw}', item.url)
    .replaceAll('{id}', item.item_id)
    .replaceAll('{platform}', item.platform)
    .replaceAll('{PLATFORM}', String(item.platform).toUpperCase());
}

export function isValidTemplate(template) {
  if (!/^https:\/\/\S+$/.test(template)) return false;
  return /\{(url|url_raw|id)\}/.test(template);
}
