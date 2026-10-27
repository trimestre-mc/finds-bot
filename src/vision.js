// Lecture d'une photo par un modèle de vision gratuit (Workers AI) : marque (logo, étiquette), modèle et type
// d'article. Complète la recherche par image de FinderQC, qui compare les formes mais rate souvent la marque.

export const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

const PROMPT = 'You identify fashion items in photos for a resale search engine. Look at logos, tags, prints and design. ' +
  'Reply with ONLY a JSON object, no other text: {"brand": "brand name or null", "model": "model or line name if recognizable ' +
  '(e.g. Tech Fleece, Air Jordan 4, Box Logo) or null", "item": "short English item type (e.g. hoodie, sneakers, bag)", ' +
  '"color": "main color in English"}. Use null when unsure; never guess a brand without a visible logo or iconic design. ' +
  'Iconic designs: Chrome Hearts = gothic/fleur crosses, daggers, horseshoe, "Made in Hollywood"; Supreme = red box logo; ' +
  'Stone Island = compass badge on the left arm; Nike = swoosh; Jordan = jumpman, Air Jordan silhouettes; Bape = ape head, ' +
  'shark hoodie, camo; Fear of God Essentials = "ESSENTIALS" text; Trapstar = "IT\'S A SECRET" or T logo; Gallery Dept = paint ' +
  'splatter, "GALLERY DEPT."; Denim Tears = cotton wreath; Corteiz = Alcatraz logo; Sp5der = spider web; Hellstar = flames and ' +
  'star; Moncler = round badge with rooster; Canada Goose = round arctic patch; Louis Vuitton = LV monogram; Gucci = GG, ' +
  'green-red stripe; Dior = oblique pattern; Balenciaga = distressed logo; Ralph Lauren = polo pony; Lacoste = crocodile; ' +
  'Arc\'teryx = bird fossil logo; The North Face = half dome logo; Off-White = diagonal stripes, arrows.';

// Petite version de l'image (le proxy de Discord sait la réduire) : moins de données et moins de quota d'IA.
export function smallImageUrl(attachment) {
  const base = attachment.proxy_url || attachment.url;
  if (!/^https:\/\/(media|cdn)\.discordapp\.(net|com)\//.test(base)) return base;
  const u = new URL(base.replace('cdn.discordapp.com', 'media.discordapp.net'));
  u.searchParams.set('width', '512');
  u.searchParams.set('height', '512');
  return u.toString();
}

async function asDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${res.status}`);
  const type = res.headers.get('content-type') || 'image/jpeg';
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) throw new Error('image trop grande');
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${type.split(';')[0]};base64,${btoa(bin)}`;
}

// Premier objet de la réponse : objet direct, liste d'objets (plusieurs articles sur la photo), ou JSON dans du texte.
function parseFirstObject(out) {
  if (Array.isArray(out)) return out.find((x) => x && typeof x === 'object') || null;
  if (out && typeof out === 'object') return out;
  const s = String(out || '').replace(/```(json)?/g, '');
  try {
    const all = JSON.parse(s.trim());
    return Array.isArray(all) ? all.find((x) => x && typeof x === 'object') || null : all;
  } catch {}
  for (const m of s.matchAll(/\{[^{}]*\}/g)) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

const clean = (v) => (typeof v === 'string' && v.trim() && !/^(null|none|unknown|n\/a)$/i.test(v.trim()) ? v.trim().slice(0, 40) : null);

// { brand, model, item, color } (champs null si inconnus), ou null si le modèle n'a pas répondu.
export async function describeImage(env, imageUrl, model = VISION_MODEL) {
  if (!env.AI) return null;
  const image = await asDataUrl(imageUrl);
  const res = await env.AI.run(model, {
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: image } }] }],
    max_tokens: 120,
    temperature: 0,
  });
  const out = typeof res === 'string' ? res
    : res && (res.response ?? (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content));
  const raw = parseFirstObject(out);
  if (!raw) {
    console.log('vision : réponse illisible', String(typeof out === 'string' ? out : JSON.stringify(res)).slice(0, 200));
    return null;
  }
  return { brand: clean(raw.brand), model: clean(raw.model), item: clean(raw.item), color: clean(raw.color) };
}
