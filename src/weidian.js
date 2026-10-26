// Lecture d'une page produit Weidian publique (titre, prix, photos, boutique).

export async function fetchWeidianItem(itemId) {
  const res = await fetch(`https://weidian.com/item.html?itemID=${itemId}`);
  if (!res.ok) throw new Error(`Weidian a répondu ${res.status}`);
  const html = (await res.text()).replaceAll('&#34;', '"').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
  const imgsBlock = pick(/"imgs"\s*:\s*\[([^\]]*)\]/) || '';
  const images = [...new Set((imgsBlock.match(/https:\/\/[^"]+/g) || []).map((u) => u.split('?')[0]))];
  return {
    title: pick(/"item_name"\s*:\s*"([^"]+)"/),
    price: parseFloat(pick(/"price"\s*:\s*"?([0-9.]+)/)) || null,
    image: images[0] || null,
    images,
    shopName: pick(/"shopName"\s*:\s*"([^"]+)"/),
    shopId: pick(/"shop_id"\s*:\s*"?(\d+)/),
  };
}
