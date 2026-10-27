// Lecture d'une photo par un modèle de vision gratuit (Workers AI) : marque (logo, étiquette), modèle et type
// d'article. Complète la recherche par image de FinderQC, qui compare les formes mais rate souvent la marque.

export const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

const BRAND_CUES = 'Iconic designs: Chrome Hearts = gothic/fleur crosses, daggers, horseshoe, "Made in Hollywood"; Supreme = red box logo, ' +
  'or "Supreme" in gothic Old English letters (often embossed or tonal); Stone Island = compass badge on the left arm; Nike = swoosh; ' +
  'Jordan = jumpman, Air Jordan silhouettes; Bape = ape head, shark hoodie, camo; Fear of God Essentials = "ESSENTIALS" text; ' +
  'Trapstar = "IT\'S A SECRET" or T logo; Gallery Dept = paint splatter, "GALLERY DEPT."; Denim Tears = cotton wreath; Corteiz = Alcatraz ' +
  'logo; Sp5der = spider web; Hellstar = flames and star; Moncler = round badge with rooster; Canada Goose = round arctic patch; ' +
  'Louis Vuitton = LV monogram; Gucci = GG, green-red stripe; Dior = oblique pattern; Balenciaga = distressed logo; Ralph Lauren = ' +
  'polo pony; Lacoste = crocodile; Arc\'teryx = bird fossil logo; The North Face = half dome logo; Off-White = diagonal stripes, arrows.';

const PROMPT = 'You identify fashion items in photos for a resale search engine. Look at logos, tags, prints and design. ' +
  'Reply with ONLY a JSON object, no other text: {"brand": "brand name or null", "model": "model or line name if recognizable ' +
  '(e.g. Tech Fleece, Air Jordan 4, Box Logo) or null", "item": "short English item type (e.g. hoodie, sneakers, bag)", ' +
  '"color": "main color in English"}. Use null when unsure; never guess a brand without a visible logo or iconic design. ' + BRAND_CUES;

// Image d'une pièce jointe Discord. L'adresse d'origine (cdn.discordapp.com) : le proxy de redimensionnement
// (media.discordapp.net) refuse les requêtes venant de Cloudflare (403).
export function smallImageUrl(attachment) {
  return attachment.url || attachment.proxy_url;
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

// ---------------------------------------------------------------- Analyse des QC par l'IA

const QC_PROMPT = (ctx) => `Tu es un expert en contrôle qualité (QC) de vêtements, chaussures et accessoires achetés via un agent en Chine.
${ctx.ref ? 'La PREMIÈRE image est la photo du vendeur (le produit attendu). Les suivantes sont les photos QC (ce que l\'agent a reçu).' : 'Les images sont des photos QC (ce que l\'agent a reçu).'}
${ctx.what ? `Article : ${ctx.what}.` : ''}
Pour reconnaître la marque, lis les logos avec soin (écriture gothique, logo en relief ou ton sur ton). Repères : ${BRAND_CUES}
Vérifie ce qui est visible : défauts (taches, trous, fils qui dépassent, colle), coutures, symétrie, logo/imprimé (placement, netteté, alignement), couleur${ctx.ref ? ' par rapport à la photo du vendeur' : ''}, étiquettes, finitions, forme.
Si une étiquette de taille est lisible, donne la taille (ex : « Étiquette : taille M »). Si une règle graduée est visible, estime une mesure utile (ex : « Longueur ≈ 50 cm »).
Ne juge PAS si c'est authentique. Ne invente rien : si un détail n'est pas visible, dis-le. Sois concret (« photo 2 : fil qui dépasse sur la manche gauche »).
Réponds UNIQUEMENT avec un objet JSON : {"article": "marque et type d'article si reconnaissables, sinon null", "verdict": "ok" ou "a_verifier" ou "probleme", "points": [{"etat": "ok" ou "attention" ou "probleme", "texte": "phrase courte en français"}], "conseil": "une phrase en français"}. 3 à 6 points.`;

// Photos (URLs) → analyse : { verdict, points: [{ etat, texte }], conseil } ou null. ref : photo du vendeur (facultative).
export async function analyzeQc(env, photos, { ref = null, what = null, model = VISION_MODEL } = {}) {
  if (!env.AI) return null;
  const images = await Promise.all([ref, ...photos].filter(Boolean).slice(0, 5).map((u) => asDataUrl(u)));
  const res = await env.AI.run(model, {
    messages: [{ role: 'user', content: [{ type: 'text', text: QC_PROMPT({ ref: !!ref, what }) }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }],
    max_tokens: 500,
    temperature: 0.1,
  });
  const out = typeof res === 'string' ? res
    : res && (res.response ?? (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content));
  const raw = parseFirstObject(out);
  if (!raw || !Array.isArray(raw.points)) {
    console.log('analyse QC : réponse illisible', String(typeof out === 'string' ? out : JSON.stringify(res)).slice(0, 200));
    return null;
  }
  const etat = (x) => (['ok', 'attention', 'probleme'].includes(x) ? x : 'attention');
  return {
    verdict: ['ok', 'a_verifier', 'probleme'].includes(raw.verdict) ? raw.verdict : 'a_verifier',
    points: raw.points.slice(0, 6).map((p) => ({ etat: etat(p.etat), texte: String(p.texte || '').slice(0, 160) })).filter((p) => p.texte),
    conseil: raw.conseil ? String(raw.conseil).slice(0, 200) : null,
    article: clean(raw.article),
    neurons: res && res.usage && res.usage.neurons,
  };
}
