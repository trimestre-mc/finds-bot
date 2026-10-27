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
${ctx.ref ? `La PREMIÈRE image est la photo du vendeur (le produit attendu). La seconde est la photo QC n°${ctx.n || 1} (ce que l'agent a reçu).` : `L'image est la photo QC n°${ctx.n || 1} (ce que l'agent a reçu).`}
${ctx.what ? `Article : ${ctx.what}.` : ''}
Pour reconnaître la marque, lis les logos avec soin (écriture gothique, logo en relief ou ton sur ton). Repères : ${BRAND_CUES}
Vérifie ce qui est visible : défauts (taches, trous, fils qui dépassent, colle), coutures, symétrie, logo/imprimé (placement, netteté, alignement), couleur${ctx.ref ? ' par rapport à la photo du vendeur' : ''}, étiquettes, finitions, forme.
Points d'expert selon le type d'article :
- Chaussures : forme du bout et du talon, symétrie des deux pieds, traces de colle, coutures, logo de semelle et de languette, étiquette intérieure (taille, code).
- Hauts (t-shirt, sweat, veste) : logo/brodé/imprimé (netteté, centrage), cordons et œillets, poignets et bas, étiquettes de col et de lavage.
- Pantalons, shorts : cordon, poches, coutures latérales, logo, étiquettes.
- Sacs, petite maroquinerie : symétrie, coutures régulières, quincaillerie (gravures, finition), logo, doublure.
- Bijoux, montres : gravures, poli, fermoir, alignement des éléments.
Étiquettes : lis-les entièrement. Chaussures : pointures US / UK / EUR / cm, code produit (ex : FQ8138-001), dates ; vérifie que les pointures sont cohérentes entre elles (ex : US 11 = UK 10 = EUR 45 = 29 cm) et que les étiquettes gauche et droite concordent. Vêtements : taille (S, M, L…) et composition.
Si une règle graduée est visible, estime une mesure utile (ex : « Longueur ≈ 70 cm ») et dis si elle paraît cohérente avec la taille de l'étiquette.
${ctx.ref ? 'Si la photo du vendeur montre plusieurs coloris (collage), ne compare pas la couleur avec elle.' : ''}
Indique le numéro de la photo QC (photo ${ctx.n || 1}). Ne te contredis pas. Évite les phrases vagues (« belle finition ») : dis ce que tu vois.
Ne juge PAS si c'est authentique. Ne invente rien : si un détail n'est pas visible, dis-le. Sois concret (« photo 2 : fil qui dépasse sur la manche gauche »).
Réponds UNIQUEMENT avec un objet JSON : {"photos": ["ce que tu vois précisément sur la photo QC"], "article": "marque et type d'article si reconnaissables, sinon null", "verdict": "ok" ou "a_verifier" ou "probleme", "points": [{"etat": "ok" ou "attention" ou "probleme", "texte": "phrase courte en français"}], "conseil": "une phrase en français"}. 2 à 5 points.`;

// Photos (URLs) → analyse : { verdict, points: [{ etat, texte }], conseil, article, vu, neurons } ou null.
// Chaque photo est analysée seule, en pleine résolution (étiquettes lisibles, détails visibles) ; la photo du vendeur
// (ref) accompagne la 1re pour la comparaison. Un modèle de texte (Gemma, presque gratuit) fusionne ensuite les
// observations en un verdict clair et sans contradiction.
const MERGE_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const etat = (x) => (['ok', 'attention', 'probleme'].includes(x) ? x : 'attention');

async function runVision(env, model, prompt, urls) {
  const images = await Promise.all(urls.map((u) => asDataUrl(u)));
  const res = await env.AI.run(model, {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }],
    max_tokens: 600,
    temperature: 0.1,
  });
  const out = typeof res === 'string' ? res
    : res && (res.response ?? (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content));
  return { raw: parseFirstObject(out), neurons: (res && res.usage && res.usage.neurons) || 0, out };
}

export async function analyzeQc(env, photos, { ref = null, what = null, model = VISION_MODEL } = {}) {
  if (!env.AI) return null;
  const shots = photos.filter(Boolean).slice(0, 3);
  if (!shots.length) return null;
  const per = await Promise.all(shots.map((u, i) => runVision(env, model, QC_PROMPT({ ref: !!(ref && i === 0), what, n: i + 1 }), [...(ref && i === 0 ? [ref] : []), u])
    .catch((err) => { console.log('analyse QC (photo)', String(err).slice(0, 160)); return { raw: null, neurons: 0 }; })));
  const ok = per.filter((p) => p.raw && Array.isArray(p.raw.points));
  let neurons = per.reduce((n, p) => n + p.neurons, 0);
  if (!ok.length) {
    console.log('analyse QC : réponses illisibles', String((per[0] && per[0].out) || '').slice(0, 200));
    return null;
  }
  const observations = ok.map((p, i) => ({
    photo: i + 1, vu: Array.isArray(p.raw.photos) ? p.raw.photos.join(' ') : '', article: p.raw.article || null, verdict: p.raw.verdict,
    points: p.raw.points.map((x) => `${etat(x.etat)} : ${x.texte}`),
  }));
  const article = clean(ok.map((p) => p.raw.article).find(Boolean));
  // Fusion par un modèle de texte ; si elle échoue, les points des photos mis bout à bout (verdict le plus sévère).
  let merged = null;
  try {
    const res = await env.AI.run(MERGE_MODEL, {
      messages: [
        { role: 'system', content: 'Tu es un expert QC de reps. On te donne les observations faites photo par photo (en JSON). Fusionne-les en une analyse finale en français : '
          + 'garde les faits précis (tailles lues, codes, mesures, défauts avec le numéro de photo), supprime les doublons et les contradictions (un fait lu sur une photo l\'emporte '
          + 'sur « pas visible » sur une autre), pas de phrases vagues. Réponds UNIQUEMENT en JSON : {"article": "marque + type précis (ex : Nike short, Air Jordan 4) ou null", "verdict": "ok" ou "a_verifier" ou "probleme", '
          + '"points": [{"etat": "ok" ou "attention" ou "probleme", "texte": "phrase courte"}], "conseil": "une phrase"}. 3 à 6 points. /no_think' },
        { role: 'user', content: JSON.stringify(observations) },
      ],
      max_tokens: 500,
      temperature: 0.1,
      chat_template_kwargs: { enable_thinking: false },
    });
    const out = typeof res.response === 'string' ? res.response : res.choices ? String(res.choices[0].message.content || '') : JSON.stringify(res.response);
    merged = parseFirstObject(out);
    neurons += (res.usage && res.usage.neurons) || 0;
  } catch (err) {
    console.log('analyse QC (fusion)', String(err).slice(0, 160));
  }
  const rank = { ok: 0, a_verifier: 1, probleme: 2 };
  if (!merged || !Array.isArray(merged.points)) {
    const worst = ok.map((p) => p.raw.verdict).reduce((a, b) => ((rank[b] ?? 1) > (rank[a] ?? 1) ? b : a), 'ok');
    merged = { verdict: worst, points: ok.flatMap((p) => p.raw.points).slice(0, 6), conseil: ok.map((p) => p.raw.conseil).find(Boolean) };
  }
  return {
    verdict: ['ok', 'a_verifier', 'probleme'].includes(merged.verdict) ? merged.verdict : 'a_verifier',
    points: merged.points.slice(0, 6).map((p) => ({ etat: etat(p.etat), texte: String(p.texte || '').slice(0, 160) })).filter((p) => p.texte),
    conseil: merged.conseil ? String(merged.conseil).slice(0, 200) : null,
    article: clean(merged.article) || article,
    vu: observations.map((o) => o.vu).filter(Boolean),
    neurons,
  };
}
