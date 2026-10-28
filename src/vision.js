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
  if (!env.DB) return false;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'groq:rest'").first().catch(() => null);
  return !!row && Number(row.value) > Date.now();
}

async function groqRest(env, err) {
  const m = String(err).match(/try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/);
  const ms = m ? ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000 : 3600000;
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

// messages au format OpenAI ; kind : 'vision' ou 'text'. Renvoie { text, neurons, provider }.
// prefer : 'groq' (analyses QC, gros quota) ou 'cloudflare' (lecture de marque, très peu coûteuse : Groq reste libre).
export async function chat(env, { messages, kind = 'vision', cfModel, maxTokens = 600, cfExtra = {}, prefer = 'groq' }) {
  if (prefer === 'cloudflare' && env.AI) {
    try {
      return await cloudflareChat(env, cfModel, messages, maxTokens, cfExtra);
    } catch (err) {
      if (!env.GROQ_API_KEY) throw err;
      console.log('cloudflare (relais vers Groq)', String(err).slice(0, 120));
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
      // Quota du jour de Groq atteint (« per day ») : on ne lui demande plus rien jusqu'à l'heure qu'il indique.
      if (res.status === 429 && /per day/i.test(err)) await groqRest(env, err);
    } catch (err) {
      console.log('groq', String(err).slice(0, 160));
    }
  }
  if (!env.AI || prefer === 'cloudflare') throw new Error('aucune IA disponible (Groq saturé)');
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
${ctx.ref ? `La PREMIÈRE image est la photo du vendeur (le produit attendu). La seconde est la photo QC n°${ctx.n || 1} (ce que l'agent a reçu).` : `L'image est la photo QC n°${ctx.n || 1} (ce que l'agent a reçu).`}
${ctx.what ? `Article : ${ctx.what}.` : ''}
Pour reconnaître la marque, lis les logos avec soin (écriture gothique, logo en relief ou ton sur ton). Repères : ${BRAND_CUES}
Ce sont des reps : sois un contrôleur SÉVÈRE. Compare à ce que tu sais du VRAI produit de la marque (forme et police exactes du logo, matière, méthode d'impression, quincaillerie, proportions) et cherche activement les signes d'un mauvais batch :
- matière bon marché (polyester brillant ou tissu fin au lieu de coton épais, aspect plastique) ;
- impression floue, pixelisée, sublimée sur tout le vêtement, couleurs baveuses ;
- logo ou police déformés (lettres mal dessinées, mauvaises proportions, mauvais espacement), motif de marque mal reproduit ;
- fermeture éclair ou boutons génériques, coutures de travers, fils, colle, étiquettes absentes ou mal imprimées.
Ne dis « net », « centré » ou « conforme » que si c'est vraiment visible et vérifié ; au moindre doute, mets « attention ».
IGNORE ce que l'agent ajoute à la photo : filigrane, QR code, logo de l'agent (ex. BBDBuy), texte chinois de l'entrepôt, règle graduée, autocollant ou carton de taille posé sur l'article. Ce ne sont pas des défauts du produit.
« probleme » seulement pour un défaut réellement visible ; un doute ou une chose à confirmer = « attention ».
Vérifie aussi : défauts (taches, trous, fils qui dépassent, colle), coutures, symétrie, couleur${ctx.ref ? ' par rapport à la photo du vendeur' : ''}, étiquettes, finitions, forme.
Points d'expert selon le type d'article :
- Chaussures : forme du bout et du talon, symétrie des deux pieds, traces de colle, coutures, logo de semelle et de languette, étiquette intérieure (taille, code).
- Hauts (t-shirt, sweat, veste) : logo/brodé/imprimé (netteté, centrage), cordons et œillets, poignets et bas, étiquettes de col et de lavage.
- Pantalons, shorts : cordon, poches, coutures latérales, logo, étiquettes.
- Sacs, petite maroquinerie : symétrie, coutures régulières, quincaillerie (gravures, finition), logo, doublure.
- Bijoux, montres : gravures, poli, fermoir, alignement des éléments.
Étiquettes : lis-les entièrement. Chaussures : pointures US / UK / EUR / cm, code produit (ex : FQ8138-001), dates ; vérifie que les pointures sont cohérentes entre elles (ex : US 11 = UK 10 = EUR 45 = 29 cm) et que les étiquettes gauche et droite concordent. Vêtements : taille (S, M, L…) et composition.
Si une règle graduée est visible, estime une mesure utile (ex : « Longueur ≈ 70 cm ») et dis si elle paraît cohérente avec la taille de l'étiquette.
${ctx.ref ? 'Si la photo du vendeur montre plusieurs coloris (collage), ne compare pas la couleur avec elle.' : ''}
Indique le numéro de la photo QC (photo ${ctx.n || 1}). Ne te contredis pas. Évite les phrases vagues (« belle finition ») : dis ce que tu vois. Sois bref : des faits, pas de longues phrases.
Ne juge PAS si c'est authentique. Ne invente rien : si un détail n'est pas visible, dis-le. Sois concret (« photo 2 : fil qui dépasse sur la manche gauche »).
Réponds UNIQUEMENT avec un objet JSON compact : {"vu": "une phrase : ce que montre la photo", "article": "marque et type d'article si reconnaissables, sinon null", "verdict": "ok" ou "a_verifier" ou "probleme", "points": [{"etat": "ok" ou "attention" ou "probleme", "texte": "phrase courte en français"}]}. 2 à 4 points.`;

// Photos (URLs) → analyse : { verdict, points: [{ etat, texte }], conseil, article, vu, neurons } ou null.
// Chaque photo est analysée seule, en pleine résolution (étiquettes lisibles, détails visibles) ; la photo du vendeur
// (ref) accompagne la 1re pour la comparaison. Un modèle de texte (Gemma, presque gratuit) fusionne ensuite les
// observations en un verdict clair et sans contradiction.
const MERGE_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const etat = (x) => (['ok', 'attention', 'probleme'].includes(x) ? x : 'attention');

async function runVision(env, model, prompt, urls) {
  // Llama 3.2 Vision (Cloudflare, demandé explicitement) : une seule image par requête, dans le champ « image ».
  if (/llama-3\.2-\d+b-vision/.test(model)) {
    const res = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }], image: await asDataUrl(urls[urls.length - 1]), max_tokens: 600, temperature: 0.1 });
    return { raw: parseFirstObject(res && res.response), neurons: (res && res.usage && res.usage.neurons) || 0, out: res && res.response };
  }
  const images = await Promise.all(urls.map((u) => asDataUrl(u)));
  const res = await chat(env, {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }],
    cfModel: model, maxTokens: 550,
  });
  return { raw: parseFirstObject(res.text), neurons: res.neurons, out: res.text, provider: res.provider };
}

export async function analyzeQc(env, photos, { ref = null, what = null, model = VISION_MODEL } = {}) {
  if (!env.AI && !env.GROQ_API_KEY) return null;
  // Avec Groq (gros quota gratuit) : jusqu'à 5 photos ; sans, 3 (quota Cloudflare).
  const shots = photos.filter(Boolean).slice(0, 3); // 3 photos : rapide, et dans les limites gratuites
  if (!shots.length) return null;
  // D'abord l'article, vu sur toutes les photos ensemble (un gros plan seul peut tromper : un logo brodé de près
  // ressemble à un bonnet) ; chaque photo est ensuite analysée en sachant ce que c'est.
  if (!what && shots.length > 1) {
    const id = await chat(env, {
      cfModel: model, maxTokens: 80, prefer: 'cloudflare',
      messages: [{ role: 'user', content: [
        { type: 'text', text: `Ces photos QC montrent UN SEUL article (gros plans et vue d'ensemble). Quel est cet article ? ${BRAND_CUES} `
          + 'Réponds UNIQUEMENT en JSON : {"article": "marque + type + couleur, 6 mots max"}.' },
        ...(await Promise.all(shots.slice(0, 2).map((u) => asDataUrl(u)))).map((url) => ({ type: 'image_url', image_url: { url } })),
      ] }],
    }).catch(() => null);
    const found = id && parseFirstObject(id.text);
    if (found && clean(found.article)) what = `${clean(found.article)} (toutes les photos montrent cet article, parfois en gros plan)`;
  }
  const one = (u, i) => runVision(env, model, QC_PROMPT({ ref: !!(ref && i === 0), what, n: i + 1 }), [...(ref && i === 0 ? [ref] : []), u])
    .catch((err) => {
      console.log('analyse QC (photo)', String(err).slice(0, 160));
      // Cloudflare sans quota (4006) : si Groq est aussi au repos pour la journée, c'est la limite du jour ; sinon Groq est
      // juste saturé pour la minute.
      const cfOut = /4006|daily free allocation/.test(String(err));
      return { raw: null, neurons: 0, quota: cfOut && !env.GROQ_API_KEY, busy: cfOut || /saturé|429/.test(String(err)), cfOut };
    });
  // Avec Groq : une photo après l'autre (limite de jetons par minute de l'offre gratuite) ; sinon en parallèle.
  let per = [];
  if (env.GROQ_API_KEY) for (const [i, u] of shots.entries()) per.push(await one(u, i));
  else per = await Promise.all(shots.map(one));
  const ok = per.filter((p) => p.raw && Array.isArray(p.raw.points));
  if (!ok.length && per.some((p) => p.quota)) throw new Error('4006 : quota d\'IA du jour épuisé');
  if (!ok.length && per.some((p) => p.cfOut) && await groqResting(env)) throw new Error('4006 : quotas d\'IA du jour épuisés (Cloudflare et Groq)');
  if (!ok.length && per.some((p) => p.busy)) throw new Error('occupe : IA très demandée');
  const photosSeen = ok.length;
  let neurons = per.reduce((n, p) => n + p.neurons, 0);
  if (!ok.length) {
    console.log('analyse QC : réponses illisibles', String((per[0] && per[0].out) || '').slice(0, 200));
    return null;
  }
  const observations = ok.map((p, i) => ({
    photo: i + 1, vu: String(p.raw.vu || (Array.isArray(p.raw.photos) ? p.raw.photos.join(' ') : '')).slice(0, 300), article: p.raw.article || null, verdict: p.raw.verdict,
    points: p.raw.points.map((x) => `${etat(x.etat)} : ${x.texte}`),
  }));
  const article = clean(ok.map((p) => p.raw.article).find(Boolean));
  // Fusion par un modèle de texte ; si elle échoue, les points des photos mis bout à bout (verdict le plus sévère).
  let merged = null;
  try {
    const res = await chat(env, {
      kind: 'text', cfModel: MERGE_MODEL, maxTokens: 700, cfExtra: { chat_template_kwargs: { enable_thinking: false } },
      messages: [
        { role: 'system', content: 'Tu es un expert QC de reps (vêtements, chaussures, sacs, bijoux achetés via un agent en Chine). On te donne les observations faites photo par photo (en JSON). '
          + 'Fusionne-les en une analyse finale en français, comme un expert : garde les faits précis (tailles lues, codes, mesures, défauts avec le numéro de photo), '
          + 'supprime les doublons et les contradictions (un fait lu sur une photo l\'emporte sur « pas visible » sur une autre), pas de phrases vagues. '
          + 'Toutes les photos montrent le même article (gros plans + vue d\'ensemble) : n\'écris JAMAIS « deux articles différents » ; si une photo semble montrer autre chose, c\'est un gros plan du même article. La couleur peut varier avec la lumière. '
          + 'Ne confonds pas la pointure (ex : US 11) avec le modèle (ex : Air Jordan 4) ; le modèle vient du design, pas de l\'étiquette de taille. '
          + 'Sois SÉVÈRE et honnête : les membres comptent sur toi pour éviter les mauvais batchs ; n\'invente aucune qualité. '
          + 'Note de 0 à 10 : 9-10 = fidèle au vrai produit et aucun défaut ; 7-8 = petits défauts mineurs ; 5-6 = défauts visibles mais portable ; '
          + '3-4 = mauvais batch (logo ou police faux, matière ou impression bon marché) ; 0-2 = défaut majeur ou article raté. '
          + 'Un logo ou une police déformés, une matière ou une impression manifestement bon marché : note 4 au plus et verdict "probleme". '
          + 'Plusieurs points « attention » sans preuve de bonne qualité : 6 au plus. '
          + 'Ignore les points sur le filigrane, le QR code, le logo de l\'agent, la règle ou un autocollant de taille posé par l\'agent : ce ne sont pas des défauts. '
          + 'Un doute (« à confirmer ») n\'est jamais un « probleme » : c\'est « attention ». '
          + 'Liste les photos importantes qui manquent pour ce type d\'article (ex : étiquette intérieure, profil, semelle, dos, logo de près, couture de près), seulement si elles manquent vraiment. '
          + 'Réponds UNIQUEMENT en JSON : {"article": "marque + type, 5 mots max (ex : Supreme hoodie gris, Air Jordan 4) ou null", "verdict": "ok" ou "a_verifier" ou "probleme", '
          + '"note": nombre de 0 à 10, "points": [{"etat": "ok" ou "attention" ou "probleme", "texte": "phrase courte"}], "manque": ["photo à demander, 6 mots max"], "conseil": "une phrase"}. 3 à 6 points. /no_think' },
        { role: 'user', content: JSON.stringify(observations) },
      ],
    });
    merged = parseFirstObject(res.text);
    neurons += res.neurons;
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
    note: Number.isFinite(Number(merged.note)) && merged.note !== null && merged.note !== '' ? Math.max(0, Math.min(10, Math.round(Number(merged.note)))) : null,
    manque: Array.isArray(merged.manque) ? merged.manque.slice(0, 4).map((x) => String(x).slice(0, 80)).filter(Boolean) : [],
    vu: observations.map((o) => o.vu).filter(Boolean),
    photos: photosSeen,
    neurons,
  };
}
