// Lecture d'une photo par un modèle de vision gratuit (Workers AI) : marque (logo, étiquette), modèle et type
// d'article. Complète la recherche par image de FinderQC, qui compare les formes mais rate souvent la marque.

import { qcGuide, knownType } from './qcguide.js';
import { kvGet, kvSet } from './kvstore.js';

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

async function loadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${res.status}`);
  const type = res.headers.get('content-type') || 'image/jpeg';
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) throw new Error('image trop grande');
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { data: `data:${type.split(';')[0]};base64,${btoa(bin)}`, size: imageSize(buf) };
}

async function asDataUrl(url) {
  return (await loadImage(url)).data;
}

// Largeur et hauteur d'une image JPEG, PNG ou WebP (lues dans l'en-tête), ou null.
export function imageSize(b) {
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: u16(i + 7), h: u16(i + 5) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8X') return { w: 1 + (b[24] | b[25] << 8 | b[26] << 16), h: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
    if (chunk === 'VP8 ') return { w: (b[26] | b[27] << 8) & 0x3fff, h: (b[28] | b[29] << 8) & 0x3fff };
    if (chunk === 'VP8L') return { w: 1 + (b[21] | (b[22] & 0x3f) << 8), h: 1 + ((b[22] >> 6) | b[23] << 2 | (b[24] & 0x0f) << 10) };
  }
  return null;
}

// Gros plan d'une zone d'une photo (box en % : [x1, y1, x2, y2]) par wsrv.nl (proxy d'images gratuit) : le logo ou
// l'étiquette agrandis, lisibles par le modèle. null si la zone n'a pas de sens.
export function cropUrl(url, box, size) {
  if (!size || !size.w || !size.h || !Array.isArray(box) || box.length !== 4) return null;
  let [x1, y1, x2, y2] = box.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (Math.max(x1, y1, x2, y2) <= 1) [x1, y1, x2, y2] = [x1, y1, x2, y2].map((v) => v * 100); // fractions au lieu de %
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  // Marge de 8 % autour, et au moins 20 % de la photo (une zone minuscule n'apprend rien).
  const grow = (a, b) => { const mid = (a + b) / 2; const half = Math.max(10, (b - a) / 2 + 8); return [Math.max(0, mid - half), Math.min(100, mid + half)]; };
  [x1, x2] = grow(x1, x2);
  [y1, y2] = grow(y1, y2);
  if (x2 - x1 > 80 && y2 - y1 > 80) return null; // presque toute la photo : pas un gros plan
  const px = (v, n) => Math.round((v / 100) * n);
  const cx = px(x1, size.w), cy = px(y1, size.h), cw = px(x2 - x1, size.w), ch = px(y2 - y1, size.h);
  if (cw < 32 || ch < 32) return null;
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&cx=${cx}&cy=${cy}&cw=${cw}&ch=${ch}&w=768&h=768&fit=inside&output=jpg&q=90`;
}

// Photo réduite (768 px) par wsrv.nl : 2 fois moins de jetons qu'en pleine taille.
const smaller = (url) => `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=768&h=768&fit=inside&we&output=jpg&q=85`;

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

// ---------------------------------------------------------------- Fournisseurs d'IA

// Groq (gratuit, ~1 000 requêtes/jour, clé GROQ_API_KEY) d'abord : même modèle de vision (Llama 4 Scout) sans toucher au
// quota Cloudflare, qui reste pour la traduction des titres. Workers AI de Cloudflare en secours (Groq saturé ou absent).
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Modèles Groq (les noms changent avec le temps : liste avec GET /api/groq-models ; réglables par GROQ_VISION_MODEL
// et GROQ_TEXT_MODEL).
const GROQ_VISION = 'qwen/qwen3.8-27b';
const GROQ_TEXT = 'openai/gpt-oss-120b';

// Groq au repos (quota du jour atteint) jusqu'à l'heure gardée dans les réglages.
async function groqResting(env) {
  const kept = await kvGet(env, 'groq:rest');
  if (kept !== undefined) return Number(kept || 0) > Date.now();
  if (!env.DB) return false;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'groq:rest'").first().catch(() => null);
  return !!row && Number(row.value) > Date.now();
}

async function groqRest(env, err) {
  const m = String(err).match(/try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/);
  const ms = m ? ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000 : 3600000;
  if (await kvSet(env, 'groq:rest', Date.now() + ms, Math.ceil(ms / 1000) + 60)) return;
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('groq:rest', ?)").bind(String(Date.now() + ms)).run().catch(() => {});
}

// Paramètres d'un modèle Groq. Qwen (photos) : sans « réflexion » (elle consomme la limite de 1 000 jetons de réponse
// par minute de l'offre gratuite) ; GPT-OSS (fusion) : réflexion courte, non renvoyée.
function groqBody(model, messages, maxTokens) {
  const body = { model, messages, max_tokens: maxTokens, temperature: 0.1 };
  if (/^qwen\//.test(model)) body.reasoning_effort = 'none';
  else if (/gpt-oss/.test(model)) { body.reasoning_effort = 'low'; body.include_reasoning = false; body.max_tokens = maxTokens + 400; }
  return body;
}

// OVHcloud AI Endpoints (gratuit et sans compte : 2 requêtes par minute et par modèle) : relais quand Groq est
// saturé, avant Cloudflare. Plusieurs modèles de vision à tour de rôle ; Qwen3.8 (le même que chez Groq), souvent
// surchargé, en dernier. OVH_OFF = 1 pour le couper.
const OVH_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
const OVH_MODELS = {
  vision: ['Qwen2.5-VL-72B-Instruct', 'Mistral-Small-3.2-24B-Instruct-2506', 'Qwen3.8-27B'],
  text: ['gpt-oss-120b', 'Qwen3.5-397B-A17B', 'Meta-Llama-3_3-70B-Instruct'],
};

async function ovhChat(env, kind, messages, maxTokens, again = true) {
  const tried = [];
  let limited = 0;
  for (const model of OVH_MODELS[kind] || OVH_MODELS.vision) {
    try {
      const res = await fetch(OVH_URL, {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', ...(env.OVH_API_KEY ? { Authorization: `Bearer ${env.OVH_API_KEY}` } : {}) },
        body: JSON.stringify({ model, messages, max_tokens: /gpt-oss/.test(model) ? maxTokens + 400 : maxTokens, temperature: 0.1 }),
      });
      if (res.ok) {
        const d = await res.json();
        const text = String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '');
        if (text) return { text, neurons: 0, provider: `ovh:${model}` };
      }
      if (res.status === 429) limited++;
      tried.push(`${model} ${res.status}`);
    } catch (err) {
      tried.push(`${model} ${String(err).slice(0, 60)}`);
    }
  }
  // Limite par minute atteinte : une pause, puis un dernier essai.
  if (again && limited) {
    await new Promise((r) => setTimeout(r, 25000));
    return ovhChat(env, kind, messages, maxTokens, false);
  }
  throw new Error(`OVH indisponible (${tried.join(', ')})`);
}

// Dernière erreur de Groq (diagnostic de /api/aiqc).
let lastGroqError = null;

// messages au format OpenAI ; kind : 'vision' ou 'text'. Renvoie { text, neurons, provider }.
// prefer : 'groq' (analyses QC, gros quota) ou 'cloudflare' (lecture de marque, très peu coûteuse : Groq reste libre).
export async function chat(env, { messages, kind = 'vision', cfModel, maxTokens = 600, cfExtra = {}, prefer = 'groq' }) {
  const ovh = () => (env.OVH_OFF ? Promise.reject(new Error('OVH coupé')) : ovhChat(env, kind, messages, maxTokens));
  if (prefer === 'cloudflare' && env.AI) {
    try {
      return await cloudflareChat(env, cfModel, messages, maxTokens, cfExtra);
    } catch (err) {
      console.log('cloudflare (relais vers OVH)', String(err).slice(0, 120));
      try { return await ovh(); } catch (e) { if (!env.GROQ_API_KEY) throw e; console.log(String(e).slice(0, 200)); }
    }
  }
  if (env.GROQ_API_KEY && !(await groqResting(env))) {
    try {
      const send = () => fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(groqBody(kind === 'vision' ? (env.GROQ_VISION_MODEL || GROQ_VISION) : (env.GROQ_TEXT_MODEL || GROQ_TEXT), messages, maxTokens)),
      });
      let res = await send();
      // Limite par minute de l'offre gratuite (jetons de réponse) : on attend ce que Groq demande (25 s au plus ;
      // au-delà, Cloudflare tout de suite).
      for (let i = 0; i < 2 && res.status === 429; i++) {
        const wait = Number(res.headers.get('retry-after')) || 5;
        if (wait > 25) break;
        await new Promise((r) => setTimeout(r, wait * 1000));
        res = await send();
      }
      if (res.ok) {
        const d = await res.json();
        return { text: String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || ''), neurons: 0, provider: 'groq' };
      }
      const err = await res.text();
      console.log('groq', res.status, err.slice(0, 300));
      lastGroqError = `${res.status} ${err.slice(0, 500)}`;
      // Quota du jour de Groq atteint (« per day ») : on ne lui demande plus rien jusqu'à l'heure qu'il indique.
      if (res.status === 429 && /per day/i.test(err)) await groqRest(env, err);
    } catch (err) {
      console.log('groq', String(err).slice(0, 160));
      lastGroqError = String(err).slice(0, 200);
    }
  }
  if (prefer !== 'cloudflare') {
    try { return await ovh(); } catch (err) { console.log(String(err).slice(0, 200)); lastGroqError = `${lastGroqError} · ${String(err).slice(0, 200)}`; }
  }
  if (!env.AI || prefer === 'cloudflare') throw new Error('aucune IA disponible (Groq et OVH saturés)');
  return cloudflareChat(env, cfModel, messages, maxTokens, cfExtra);
}

async function cloudflareChat(env, cfModel, messages, maxTokens, cfExtra) {
  const res = await env.AI.run(cfModel, { messages, max_tokens: maxTokens, temperature: 0.1, ...cfExtra });
  const out = typeof res === 'string' ? res
    : res && (res.response ?? (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content));
  return { text: typeof out === 'string' ? out : JSON.stringify(out), neurons: (res && res.usage && res.usage.neurons) || 0, provider: 'cloudflare' };
}

const clean = (v) => (typeof v === 'string' && v.trim() && !/^(null|none|unknown|n\/a)$/i.test(v.trim()) ? v.trim().slice(0, 40) : null);

// { brand, model, item, color } (champs null si inconnus), ou null si le modèle n'a pas répondu.
export async function describeImage(env, imageUrl, model = VISION_MODEL) {
  if (!env.AI && !env.GROQ_API_KEY) return null;
  const image = await asDataUrl(imageUrl);
  const res = await chat(env, {
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: image } }] }],
    cfModel: model, maxTokens: 120, prefer: 'cloudflare',
  });
  const out = res.text;
  const raw = parseFirstObject(out);
  if (!raw) {
    console.log('vision : réponse illisible', String(out).slice(0, 200));
    return null;
  }
  return { brand: clean(raw.brand), model: clean(raw.model), item: clean(raw.item), color: clean(raw.color), neurons: res.neurons };
}

// ---------------------------------------------------------------- Analyse des QC par l'IA

const QC_PROMPT = (ctx) => `Tu es un expert en contrôle qualité (QC) de vêtements, chaussures et accessoires achetés via un agent en Chine.
${ctx.ref ? 'La PREMIÈRE image est la photo du vendeur (le produit attendu). La suivante est' : ctx.count > 1 ? 'Les images sont' : 'L\'image est'} ${ctx.count > 1 ? `les photos QC n°${ctx.from} et n°${ctx.from + 1}` : `la photo QC n°${ctx.from}`} (ce que l'agent a reçu) : un article vu en entier ou en gros plan.
${ctx.what ? `Article : ${ctx.what}.` : ''}
${ctx.what ? '' : `Pour reconnaître la marque, lis les logos avec soin (écriture gothique, logo en relief ou ton sur ton). Repères : ${BRAND_CUES}`}
Ce sont des reps : sois un contrôleur SÉVÈRE. Compare à ce que tu sais du VRAI produit de la marque (forme et police exactes du logo, matière, méthode d'impression, quincaillerie, proportions) et cherche activement les signes d'un mauvais batch :
- matière bon marché (polyester brillant ou tissu fin au lieu de coton épais, aspect plastique) ;
- impression floue, pixelisée, sublimée sur tout le vêtement, couleurs baveuses ;
- logo ou police déformés (lettres mal dessinées, mauvaises proportions, mauvais espacement), motif de marque mal reproduit ;
- fermeture éclair ou boutons génériques, coutures de travers, fils, colle, étiquettes absentes ou mal imprimées.
Ne dis « net », « centré » ou « conforme » que si c'est vraiment visible et vérifié ; au moindre doute, mets « attention ».
IGNORE ce que l'agent ajoute à la photo : filigrane, QR code, logo de l'agent (ex. BBDBuy), texte chinois de l'entrepôt, règle graduée, autocollant ou carton de taille posé sur l'article. Ce ne sont pas des défauts du produit.
« probleme » seulement pour un défaut réellement visible ; un doute ou une chose à confirmer = « attention ».
Vérifie aussi : défauts (taches, trous, fils qui dépassent, colle), coutures, symétrie, couleur${ctx.ref ? ' par rapport à la photo du vendeur' : ''}, étiquettes, finitions, forme.
${qcGuide(ctx.what)}
${knownType(ctx.what) ? '' : `Points d'expert selon le type d'article :
- Chaussures : forme du bout et du talon, symétrie des deux pieds, traces de colle, coutures, logo de semelle et de languette, étiquette intérieure (taille, code).
- Hauts (t-shirt, sweat, veste) : logo/brodé/imprimé (netteté, centrage), cordons et œillets, poignets et bas, étiquettes de col et de lavage.
- Pantalons, shorts : cordon, poches, coutures latérales, logo, étiquettes.
- Sacs, petite maroquinerie : symétrie, coutures régulières, quincaillerie (gravures, finition), logo, doublure.
- Bijoux, montres : gravures, poli, fermoir, alignement des éléments.
`}Étiquettes : lis-les entièrement. Chaussures : pointures US / UK / EUR / cm, code produit (ex : FQ8138-001), dates ; vérifie que les pointures sont cohérentes entre elles (ex : US 11 = UK 10 = EUR 45 = 29 cm) et que les étiquettes gauche et droite concordent. Vêtements : taille (S, M, L…) et composition.
Si une règle graduée est visible, estime une mesure utile (ex : « Longueur ≈ 70 cm ») et dis si elle paraît cohérente avec la taille de l'étiquette.
${ctx.ref ? 'Si la photo du vendeur montre plusieurs coloris (collage), ne compare pas la couleur avec elle.' : ''}
Indique le numéro de la photo QC concernée (« photo 2 : … »). Ne te contredis pas. Évite les phrases vagues (« belle finition ») : dis ce que tu vois. Sois bref : des faits, pas de longues phrases.
Ne juge PAS si c'est authentique. Ne invente rien : si un détail n'est pas visible, dis-le. Sois concret (« photo 2 : fil qui dépasse sur la manche gauche »).
Réponds UNIQUEMENT avec un objet JSON compact : {"vu": "une phrase : ce que montrent les photos", "article": "marque et type d'article si reconnaissables, sinon null", "verdict": "ok" ou "a_verifier" ou "probleme", "points": [{"etat": "ok" ou "attention" ou "probleme", "texte": "phrase courte en français"}], "zoom": {"photo": ${ctx.count > 1 ? `${ctx.from} ou ${ctx.from + 1}` : ctx.from}, "zone": [x1, y1, x2, y2] en % de cette photo (0 à 100)} = le logo, la police, l'étiquette ou la broderie DE L'ARTICLE à voir de près (jamais l'emballage, le carton, un papier ou la règle), ou null si aucun n'est visible}. 3 à 6 points.`;

// Gros plan (zoom) d'une photo QC : juger l'exécution du logo ou de l'étiquette.
const ZOOM_PROMPT = (ctx) => `Tu es un expert en contrôle qualité (QC) de reps achetés via un agent en Chine. L'image est un GROS PLAN (zoom) de la photo QC n°${ctx.n}${ctx.what ? ` (article : ${ctx.what})` : ''}.
Juge comme un contrôleur SÉVÈRE l'exécution de ce détail par rapport au vrai produit : forme et police exactes du logo (épaisseur, espacement, proportions des lettres), densité et régularité de la broderie (fils sautés, fond visible), netteté de l'impression (pixels, bavures, film plastique), texte des étiquettes lu mot à mot (fautes, police, pointures cohérentes), quincaillerie gravée.
IGNORE filigrane, QR code, logo de l'agent, règle et autocollant de taille. N'invente rien ; un doute = « attention » ; « probleme » seulement pour un défaut net.
Si le gros plan ne montre pas l'article lui-même (emballage, papier, carton, fond, règle), réponds seulement {"utile": false}.
${qcGuide(ctx.what)}
Réponds UNIQUEMENT avec un objet JSON compact : {"utile": true, "vu": "ce que montre le gros plan", "verdict": "ok" ou "a_verifier" ou "probleme", "points": [{"etat": "ok" ou "attention" ou "probleme", "texte": "phrase courte en français, commence par « Gros plan photo ${ctx.n} : »"}]}. 1 à 3 points.`;

// Comparaison avec la QC d'un autre acheteur (de préférence d'un batch jugé GL).
const GOLD_PROMPT = (ctx) => `Tu es un expert en contrôle qualité (QC) de reps achetés via un agent en Chine.
La PREMIÈRE image est la photo QC d'un AUTRE acheteur, ${ctx.same ? 'du même article' : 'de l\'article qui ressemble le plus (peut-être pas exactement le même)'}${ctx.gl ? ', jugé GL (bon) par les membres' : ''} : c'est la référence. La SECONDE est la QC à contrôler${ctx.what ? ` (article : ${ctx.what})` : ''}.
${ctx.same ? '' : 'Si les deux images ne montrent clairement pas le même article, réponds {"meme": false, "points": []}. '}Compare seulement ce qui est visible sur les deux (l'angle et la lumière peuvent changer) : forme et police du logo, taille et placement du logo, couleurs, matière (épaisseur, brillance), forme générale, détails (zip, cordons, coutures, semelle).
Une différence nette avec la référence (logo plus fin, police différente, couleur autre, matière brillante) = « probleme » ou « attention » ; identique = « ok ». IGNORE filigrane, QR code, logo de l'agent, règle, autocollant.
Réponds UNIQUEMENT avec un objet JSON compact : {"meme": true ou false, "verdict": "ok" ou "a_verifier" ou "probleme", "points": [{"etat": "ok" ou "attention" ou "probleme", "texte": "phrase courte en français, commence par « Comparé à un autre batch : »"}]}. 1 à 3 points.`;

// 2e lecture des points incertains (note entre 5 et 7) : chaque doute est confirmé ou levé.
const VERIFY_PROMPT = (ctx) => `Tu es un expert en contrôle qualité (QC) de reps. Ces photos QC${ctx.what ? ` (article : ${ctx.what})` : ''} ont reçu une première analyse avec des doutes. Regarde-les à nouveau, attentivement, et tranche chaque doute :
${ctx.doubts.map((d, i) => `${i + 1}. ${d}`).join('\n')}
Pour chacun : « ok » si c'est bien fait et visible, « probleme » si le défaut est réel et visible, « attention » seulement si c'est vraiment impossible à voir sur ces photos. Sois SÉVÈRE et précis (numéro de photo). IGNORE filigrane, QR code, logo de l'agent, règle, autocollant.
${qcGuide(ctx.what)}
Réponds UNIQUEMENT avec un objet JSON compact : {"points": [{"etat": "ok" ou "attention" ou "probleme", "texte": "phrase courte en français : le doute et ta conclusion"}]}. Un point par doute.`;

// Photos (URLs) → analyse : { verdict, points: [{ etat, texte }], conseil, article, vu, neurons } ou null.
// Chaque photo est analysée seule, en pleine résolution (étiquettes lisibles, détails visibles) ; la photo du vendeur
// (ref) accompagne la 1re pour la comparaison. Un modèle de texte (Gemma, presque gratuit) fusionne ensuite les
// observations en un verdict clair et sans contradiction.
const MERGE_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const etat = (x) => (['ok', 'attention', 'probleme'].includes(x) ? x : 'attention');

async function runVision(env, model, prompt, urls, load = asDataUrl, maxTokens = 450) {
  // Llama 3.2 Vision (Cloudflare, demandé explicitement) : une seule image par requête, dans le champ « image ».
  if (/llama-3\.2-\d+b-vision/.test(model)) {
    const res = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }], image: await asDataUrl(urls[urls.length - 1]), max_tokens: 600, temperature: 0.1 });
    return { raw: parseFirstObject(res && res.response), neurons: (res && res.usage && res.usage.neurons) || 0, out: res && res.response };
  }
  const images = await Promise.all(urls.map((u) => load(u)));
  const res = await chat(env, {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }],
    cfModel: model, maxTokens,
  });
  return { raw: parseFirstObject(res.text), neurons: res.neurons, out: res.text, provider: res.provider };
}

const MERGE_SYSTEM = 'Tu es un expert QC de reps (vêtements, chaussures, sacs, bijoux achetés via un agent en Chine). On te donne les observations faites photo par photo (en JSON). '
  + 'Fusionne-les en une analyse finale en français, comme un expert : garde les faits précis (tailles lues, codes, mesures, défauts avec le numéro de photo), '
  + 'supprime les doublons et les contradictions (un fait lu sur une photo l\'emporte sur « pas visible » sur une autre), pas de phrases vagues. '
  + 'Toutes les photos montrent le même article (gros plans + vue d\'ensemble) : n\'écris JAMAIS « deux articles différents » ; si une photo semble montrer autre chose, c\'est un gros plan du même article. La couleur peut varier avec la lumière. '
  + 'Ne confonds pas la pointure (ex : US 11) avec le modèle (ex : Air Jordan 4) ; le modèle vient du design, pas de l\'étiquette de taille. '
  + 'Les observations « gros plan » (zoom sur le logo ou l\'étiquette) sont les plus fiables pour juger le logo, la police et la broderie. '
  + 'Les observations « comparaison » viennent de la QC d\'un autre acheteur prise comme référence : une différence nette avec elle compte beaucoup. '
  + 'Une « 2e lecture » (vérification ciblée des doutes) l\'emporte sur la première lecture des mêmes points. '
  + 'Sois SÉVÈRE et honnête : les membres comptent sur toi pour éviter les mauvais batchs ; n\'invente aucune qualité. '
  + 'Note de 0 à 10 : 9-10 = fidèle au vrai produit et aucun défaut ; 7-8 = petits défauts mineurs ; 5-6 = défauts visibles mais portable ; '
  + '3-4 = mauvais batch (logo ou police faux, matière ou impression bon marché) ; 0-2 = défaut majeur ou article raté. '
  + 'Un logo ou une police déformés, une matière ou une impression manifestement bon marché : note 4 au plus et verdict "probleme". '
  + 'Plusieurs points « attention » sans preuve de bonne qualité : 6 au plus. '
  + 'Ignore les points sur le filigrane, le QR code, le logo de l\'agent, la règle ou un autocollant de taille posé par l\'agent : ce ne sont pas des défauts. '
  + 'Un doute (« à confirmer ») n\'est jamais un « probleme » : c\'est « attention ». '
  + 'Liste les photos importantes qui manquent pour ce type d\'article (ex : étiquette intérieure, profil, semelle, dos, logo de près, couture de près), seulement si elles manquent vraiment. '
  + 'Réponds UNIQUEMENT en JSON : {"article": "marque + type, 5 mots max (ex : Supreme hoodie gris, Air Jordan 4) ou null", "verdict": "ok" ou "a_verifier" ou "probleme", '
  + '"note": nombre de 0 à 10, "points": [{"etat": "ok" ou "attention" ou "probleme", "texte": "phrase courte"}], "manque": ["photo à demander, 6 mots max"], "conseil": "une phrase"}. 3 à 6 points. /no_think';

const noteOf = (m) => (m && Number.isFinite(Number(m.note)) && m.note !== null && m.note !== '' ? Math.max(0, Math.min(10, Math.round(Number(m.note)))) : null);

// gold : { url, same, gl } = QC d'un autre acheteur prise comme référence (même article, ou article qui ressemble).
export async function analyzeQc(env, photos, { ref = null, what = null, model = VISION_MODEL, gold = null, trace = null, progress = null } = {}) {
  const step = (k) => (progress ? progress(k) : null);
  const note = (step, x) => { if (trace) trace.push(`${step} : ${String(x).slice(0, 700)}`); };
  if (!env.AI && !env.GROQ_API_KEY) return null;
  const shots = photos.filter(Boolean).slice(0, 3); // 3 photos : rapide, et dans les limites gratuites
  if (!shots.length) return null;
  // Chaque image n'est téléchargée qu'une fois (taille gardée pour les gros plans).
  const loaded = new Map();
  const image = (u) => { if (!loaded.has(u)) loaded.set(u, loadImage(u)); return loaded.get(u); };
  const load = async (u) => (await image(u)).data;
  // Vues d'ensemble réduites à 768 px (2 fois moins de jetons) : les détails passent par le gros plan, pris sur la
  // photo d'origine. Photo d'origine si le proxy d'images ne répond pas.
  const view = (u) => (/^https:\/\/wsrv\.nl\//.test(u) ? load(u) : load(smaller(u)).catch(() => load(u)));
  // D'abord l'article, vu sur toutes les photos ensemble (un gros plan seul peut tromper : un logo brodé de près
  // ressemble à un bonnet) ; chaque photo est ensuite analysée en sachant ce que c'est.
  if (!what && shots.length > 1) {
    const id = await chat(env, {
      cfModel: model, maxTokens: 80, prefer: 'cloudflare',
      messages: [{ role: 'user', content: [
        { type: 'text', text: `Ces photos QC montrent UN SEUL article (gros plans et vue d'ensemble). Quel est cet article ? ${BRAND_CUES} `
          + 'Réponds UNIQUEMENT en JSON : {"article": "marque + type + couleur, 6 mots max"}.' },
        ...(await Promise.all(shots.slice(0, 2).map(view))).map((url) => ({ type: 'image_url', image_url: { url } })),
      ] }],
    }).catch(() => null);
    const found = id && parseFirstObject(id.text);
    if (found && clean(found.article)) what = `${clean(found.article)} (toutes les photos montrent cet article, parfois en gros plan)`;
  }
  const failure = (err) => {
    console.log('analyse QC (photo)', String(err).slice(0, 160));
    note('erreur', `${err} · Groq : ${lastGroqError}`);
    // Cloudflare sans quota (4006) : si Groq est aussi au repos pour la journée, c'est la limite du jour ; sinon Groq est
    // juste saturé pour la minute.
    const cfOut = /4006|daily free allocation/.test(String(err));
    return { raw: null, neurons: 0, quota: cfOut && !env.GROQ_API_KEY, busy: cfOut || /saturé|429/.test(String(err)), cfOut };
  };
  // Avec Groq : les étapes l'une après l'autre (limite de jetons par minute de l'offre gratuite) ; sinon en parallèle.
  const inTurn = async (tasks) => {
    if (!env.GROQ_API_KEY) return Promise.all(tasks.map((t) => t()));
    const out = [];
    for (const t of tasks) out.push(await t());
    return out;
  };
  // Photos par groupes de 2 (Groq refuse plus de 7 000 jetons par requête) : les consignes, l'essentiel des jetons, ne
  // sont envoyées qu'une fois par groupe. La photo du vendeur accompagne la 1re photo QC, seule.
  const groups = [];
  for (let i = 0; i < shots.length;) {
    const size = ref && i === 0 ? 1 : 2;
    groups.push({ from: i, urls: shots.slice(i, i + size) });
    i += size;
  }
  step('photos');
  const per = await inTurn(groups.map((g) => () => runVision(env, model,
    QC_PROMPT({ ref: !!(ref && g.from === 0), what, from: g.from + 1, count: g.urls.length }),
    [...(ref && g.from === 0 ? [ref] : []), ...g.urls], view).catch(failure)));
  per.forEach((p, i) => note(`photos du groupe ${i + 1}`, p.raw ? `ok, zoom ${JSON.stringify(p.raw.zoom || null)}` : `illisible : ${p.out || ''}`));
  const ok = per.filter((p) => p.raw && Array.isArray(p.raw.points));
  if (!ok.length && per.some((p) => p.quota)) throw new Error('4006 : quota d\'IA du jour épuisé');
  if (!ok.length && per.some((p) => p.cfOut) && await groqResting(env)) throw new Error('4006 : quotas d\'IA du jour épuisés (Cloudflare et Groq)');
  if (!ok.length && per.some((p) => p.busy)) throw new Error('occupe : IA très demandée');
  const photosSeen = per.reduce((n, p, i) => n + (p.raw && Array.isArray(p.raw.points) ? groups[i].urls.length : 0), 0);
  let neurons = per.reduce((n, p) => n + p.neurons, 0);
  if (!ok.length) {
    console.log('analyse QC : réponses illisibles', String((per[0] && per[0].out) || '').slice(0, 200));
    return null;
  }
  const observations = per.map((p, i) => [p, groups[i]]).filter(([p]) => p.raw && Array.isArray(p.raw.points)).map(([p, g]) => ({
    photo: g.urls.length > 1 ? `photos ${g.from + 1} et ${g.from + 2}` : `photo ${g.from + 1}`, vu: String(p.raw.vu || '').slice(0, 300), article: p.raw.article || null, verdict: p.raw.verdict,
    points: p.raw.points.map((x) => `${etat(x.etat)} : ${x.texte}`),
  }));
  const article = clean(ok.map((p) => p.raw.article).find(Boolean));
  const known = [what, article].filter(Boolean).join(' · ') || null;

  // En plus : gros plan du logo ou de l'étiquette (zone choisie par le modèle) et comparaison avec un autre batch.
  const extra = [];
  // Zone à agrandir : { photo, zone } (ou directement [x1, y1, x2, y2] pour la photo 1).
  const zi = per.findIndex((p) => p.raw && p.raw.zoom);
  const z = zi >= 0 ? per[zi].raw.zoom : null;
  const zoomOf = z ? Math.max(0, Math.min(shots.length - 1, (Number(Array.isArray(z) ? 0 : z.photo) || groups[zi].from + 1) - 1)) : -1;
  const zone = z && (Array.isArray(z) ? z : z.zone);
  if (zoomOf >= 0 && zone) {
    extra.push(async () => {
      step('zoom');
      const size = (await image(shots[zoomOf]).catch(() => ({}))).size;
      const crop = cropUrl(shots[zoomOf], zone, size);
      note('gros plan', crop || `pas de zone (taille ${JSON.stringify(size || null)})`);
      if (!crop) return null;
      const r = await runVision(env, model, ZOOM_PROMPT({ n: zoomOf + 1, what: known }), [crop], load, 250).catch(failure);
      return r.raw && r.raw.utile !== false && Array.isArray(r.raw.points) && r.raw.points.length ? { r, obs: { photo: `gros plan de la photo ${zoomOf + 1}`, vu: String(r.raw.vu || '').slice(0, 200), points: r.raw.points.map((x) => `${etat(x.etat)} : ${x.texte}`) } } : { r };
    });
  }
  if (gold && gold.url && !shots.includes(gold.url)) {
    extra.push(async () => {
      step('compare');
      note('comparaison', gold.url);
      const r = await runVision(env, model, GOLD_PROMPT({ same: gold.same, gl: gold.gl, what: known }), [gold.url, shots[0]], view, 250).catch(failure);
      return r.raw && (gold.same || r.raw.meme !== false) && Array.isArray(r.raw.points) && r.raw.points.length
        ? { r, obs: { photo: `comparaison avec la QC d'un autre acheteur${gold.gl ? ' (batch jugé GL)' : ''}`, points: r.raw.points.map((x) => `${etat(x.etat)} : ${x.texte}`) } } : { r };
    });
  }
  let compared = false;
  let zoomed = false;
  for (const x of await inTurn(extra.map((t) => () => t().catch((err) => { note('étape en plus', err); return null; })))) {
    if (!x) continue;
    note('résultat en plus', x.obs ? JSON.stringify(x.obs.points) : `rien : ${x.r.out || ''}`);
    neurons += x.r.neurons || 0;
    if (!x.obs) continue;
    observations.push(x.obs);
    if (/comparaison/.test(x.obs.photo)) compared = true; else zoomed = true;
  }

  // Fusion par un modèle de texte ; si elle échoue, les points des photos mis bout à bout (verdict le plus sévère).
  const merge = async (obs) => {
    const res = await chat(env, {
      kind: 'text', cfModel: MERGE_MODEL, maxTokens: 700, cfExtra: { chat_template_kwargs: { enable_thinking: false } },
      messages: [
        { role: 'system', content: MERGE_SYSTEM },
        { role: 'user', content: `${qcGuide([what, ...obs.map((o) => o.article)].filter(Boolean).join(' '))}\nObservations : ${JSON.stringify(obs)}` },
      ],
    });
    neurons += res.neurons;
    const m = parseFirstObject(res.text);
    return m && Array.isArray(m.points) ? m : null;
  };
  step('merge');
  let merged = await merge(observations).catch((err) => { console.log('analyse QC (fusion)', String(err).slice(0, 160)); return null; });

  // Note entre 5 et 7 : les doutes sont revus sur les photos concernées, puis l'analyse est refaite.
  let verified = false;
  const doubts = merged ? merged.points.filter((p) => etat(p.etat) !== 'ok').map((p) => String(p.texte || '')).filter(Boolean).slice(0, 4) : [];
  if (merged && noteOf(merged) >= 5 && noteOf(merged) <= 7 && doubts.length) {
    const cited = [...new Set(doubts.flatMap((d) => [...d.matchAll(/photo (\d)/gi)].map((m) => Number(m[1]) - 1)))].filter((i) => shots[i]);
    const look = (cited.length ? cited : [0, 1]).filter((i) => shots[i]).slice(0, 2).map((i) => shots[i]);
    step('verify');
    note('2e lecture', doubts.join(' | '));
    const r = await runVision(env, model, VERIFY_PROMPT({ doubts, what: known }), look, view, 300).catch(failure);
    neurons += r.neurons || 0;
    if (r.raw && Array.isArray(r.raw.points) && r.raw.points.length) {
      const again = await merge([...observations, { photo: '2e lecture des doutes', points: r.raw.points.map((x) => `${etat(x.etat)} : ${x.texte}`) }]).catch(() => null);
      if (again) { merged = again; verified = true; }
    }
  }

  const rank = { ok: 0, a_verifier: 1, probleme: 2 };
  if (!merged) {
    const worst = ok.map((p) => p.raw.verdict).reduce((a, b) => ((rank[b] ?? 1) > (rank[a] ?? 1) ? b : a), 'ok');
    merged = { verdict: worst, points: ok.flatMap((p) => p.raw.points).slice(0, 6), conseil: ok.map((p) => p.raw.conseil).find(Boolean) };
  }
  return {
    verdict: ['ok', 'a_verifier', 'probleme'].includes(merged.verdict) ? merged.verdict : 'a_verifier',
    points: merged.points.slice(0, 6).map((p) => ({ etat: etat(p.etat), texte: String(p.texte || '').slice(0, 160) })).filter((p) => p.texte),
    conseil: merged.conseil ? String(merged.conseil).slice(0, 200) : null,
    article: clean(merged.article) || article,
    note: noteOf(merged),
    manque: Array.isArray(merged.manque) ? merged.manque.slice(0, 4).map((x) => String(x).slice(0, 80)).filter(Boolean) : [],
    vu: observations.map((o) => o.vu).filter(Boolean),
    photos: photosSeen,
    extras: { zoom: zoomed, compared, verified },
    neurons,
  };
}
