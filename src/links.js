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

// Remplit le modèle d'un agent pour un item.
export function buildAgentLink(template, item) {
  return template
    .replaceAll('{url}', encodeURIComponent(item.url))
    .replaceAll('{url_raw}', item.url)
    .replaceAll('{id}', item.item_id)
    .replaceAll('{platform}', item.platform);
}

export function isValidTemplate(template) {
  if (!/^https:\/\/\S+$/.test(template)) return false;
  return /\{(url|url_raw|id)\}/.test(template);
}
