// Titres : un modèle de langage (Workers AI, quota gratuit) réécrit les titres chinois des vendeurs
// en titres produit courts et propres en anglais. m2m100 sert de secours.

import { chineseBrandNames } from './synonyms.js';

const MT_MODEL = '@cf/meta/m2m100-1.2b';
// Gemma 4 : meilleurs titres que Llama 3.3 70B sur nos tests (marques reconnues) et ~5 fois moins cher en neurons.
const LLM_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const BATCH = 40; // plus de titres par appel : les consignes, envoyées à chaque appel, coûtent moins par titre

export async function translate(env, text, from, to) {
  if (!text || !text.trim()) return '';
  const out = await env.AI.run(MT_MODEL, { text, source_lang: from, target_lang: to });
  return (out && out.translated_text ? out.translated_text : '').trim();
}

const SYSTEM = `You turn messy Chinese marketplace listing titles into clean English product titles for a shopping catalog.
For each title:
- Write 3 to 8 words in Title Case: [Brand if explicitly present] + [model/collection code if present] + [color if given] + [item type].
- Item type must be exact: 手镯 = bracelet, 项链 = necklace, 戒指 = ring, 墨镜 = sunglasses, 卫衣 = hoodie/sweatshirt, 卫裤 = sweatpants, 短袖/T恤/tee = tee, 长袖 = long sleeve tee, 短裤 = shorts, 牛仔裤 = jeans, 夹克 = jacket, 外套 = jacket/coat, 针织 = knit.
- Brands: use a brand ONLY if it is written in Latin letters (Nike, BAL, Sup, ALO, Acne, Off White, CDG, TNF) or is one of these Chinese names/nicknames. Otherwise write no brand; never guess from the style.
  克罗心/CH = Chrome Hearts; 巴黎世家/巴黎/双b = Balenciaga; 小香/香奈儿 = Chanel; 小马/拉夫劳伦/RL = Ralph Lauren; 博柏利/巴宝莉/某b = Burberry;
  踢不烂/TBL/大黄靴 = Timberland; 葆蝶家/bv = Bottega Veneta; 古驰 = Gucci; 普拉达 = Prada; 路易威登/LV = Louis Vuitton; 迪奥 = Dior;
  芬迪 = Fendi; 圣罗兰/YSL = Saint Laurent; 罗意威 = Loewe; 蒙口/蒙克莱/盟可睐 = Moncler; 大鹅/加拿大鹅 = Canada Goose; 始祖鸟 = Arc'teryx;
  北面 = The North Face; 斯图西 = Stussy; 椰子/侃爷 = Yeezy; 耐克 = Nike; 阿迪 = Adidas; 新百伦 = New Balance; 亚瑟士 = Asics; 萨洛蒙 = Salomon;
  马吉拉/MM6 = Maison Margiela; 德训鞋 = German Army Trainer; 鳄鱼 = Lacoste; 汤姆布朗/TB = Thom Browne; 川久保玲 = Comme des Garcons;
  卡哈特 = Carhartt; 恐惧之神/FOG/ESS = Fear of God Essentials; 棕榈天使 = Palm Angels; 爱马仕 = Hermes; 卡地亚 = Cartier;
  梵克雅宝/四叶草 = Van Cleef & Arpels; 宝格丽 = Bulgari; 劳力士 = Rolex; 欧米茄 = Omega; 老爹鞋 = dad sneakers.
- Drop seller names and shop slogans (XX出品, XXmade, Rain Made, 杰尼龟, 我是呼吸, 自主, 现货, 发出, 库存, 不退换, 到货转寄, celebrity names, internal codes like #H134), and fabric/process details.
Reply with ONLY a JSON array of strings, same order and same count as the input.`;

// Noms chinois et surnoms de marques → nom anglais, repris de la liste ci-dessus (« 蒙口 » → « Moncler »). Appliqué
// avant la traduction mot à mot (m2m100), qui ne connaît pas ces surnoms de vendeurs.
const GLOSSARY = (() => {
  const pairs = [];
  for (const m of SYSTEM.matchAll(/([^;\n]+?) = ([^;\n]+?)(?=;|\.\n|\n|$)/g)) {
    const en = m[2].trim().replace(/\.$/, '');
    for (const zh of m[1].split('/')) if (/[\u4e00-\u9fff]/.test(zh)) pairs.push([zh.trim().replace(/^.*: /, ''), en]);
  }
  // Plus les noms chinois des marques connues de la recherche (synonyms.js), s'ils ne sont pas déjà dans la liste.
  const known = new Set(pairs.map(([zh]) => zh));
  for (const [zh, en] of chineseBrandNames()) if (!known.has(zh)) pairs.push([zh, en]);
  return pairs.filter(([zh]) => zh.length >= 2).sort((a, b) => b[0].length - a[0].length);
})();

export function applyGlossary(title) {
  let t = String(title || '');
  for (const [zh, en] of GLOSSARY) if (t.includes(zh)) t = t.split(zh).join(` ${en} `);
  return t.replace(/\s{2,}/g, ' ').trim();
}

// Traduction rapide et très peu coûteuse (m2m100) : marques remplacées d'abord, puis mise en forme.
export async function quickTitles(env, titles) {
  const out = await Promise.all(titles.map((t) => translate(env, applyGlossary(t), 'zh', 'en').catch(() => '')));
  return out.map((t) => tidyTitle(t.replace(/\b(\w)(\w*)/g, (_, a, b) => a.toUpperCase() + b)));
}

// Nettoie un titre déjà en anglais (au cas où le modèle ajoute des guillemets ou de la ponctuation).
export function tidyTitle(t) {
  return String(t || '')
    .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
    .replace(/\s*[\/|]+\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 120)
    .trim();
}

// Consignes courtes : les marques chinoises sont déjà remplacées par applyGlossary, plus besoin de la liste
// (≈ 3 fois moins de jetons envoyés par lot, donc plus de titres avec le même quota d'IA).
const SYSTEM_SHORT = `Turn messy marketplace listing titles (Chinese, some words already in English) into clean English product titles.
For each title: 3 to 8 words in Title Case = [Brand if explicitly present] + [model/code if present] + [color if given] + [item type].
Exact item types: 手镯 bracelet, 项链 necklace, 戒指 ring, 墨镜 sunglasses, 卫衣 hoodie/sweatshirt, 卫裤 sweatpants, 短袖/T恤 tee, 长袖 long sleeve tee, 短裤 shorts, 牛仔裤 jeans, 夹克/外套 jacket, 羽绒服 down jacket, 马甲 vest, 针织 knit, 包 bag.
Never guess a brand that is not written. Drop seller names, slogans, stock/shipping words (现货, 秒发, 发出, 不退换), fabric details and internal codes.
Reply with ONLY a JSON array of strings, same order and count as the input.`;

export async function rewriteTitles(env, titles, model = LLM_MODEL, opts = {}) {
  // Modèles « qui réfléchissent » (Qwen3, Gemma 4…) : réflexion coupée, sinon elle mange tous les jetons.
  const reasoning = !/llama/.test(model);
  const res = await env.AI.run(model, {
    messages: [
      { role: 'system', content: opts.short ? SYSTEM_SHORT : SYSTEM },
      { role: 'user', content: JSON.stringify(opts.short ? titles.map(applyGlossary) : titles) + (reasoning ? ' /no_think' : '') },
    ],
    max_tokens: 60 + titles.length * 30,
    temperature: 0.2,
    ...(reasoning ? { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' } : {}),
  });
  const raw = typeof res.response === 'string' ? res.response
    : res.choices ? String(res.choices[0].message.content || '') : JSON.stringify(res.response);
  const match = raw.match(/\[[\s\S]*\]/);
  const arr = match ? JSON.parse(match[0]) : null;
  if (!Array.isArray(arr) || arr.length !== titles.length) throw new Error(`réponse inattendue: ${(raw || JSON.stringify(res)).slice(0, 400)}`);
  if (opts.usage) opts.usage.push(res.usage || null);
  return arr.map(tidyTitle);
}

// Le modèle renvoie parfois une liste vide ou incomplète : on réessaie en deux moitiés.
async function rewriteInHalves(env, titles, usage = []) {
  const opts = { short: true, usage };
  try {
    return await rewriteTitles(env, titles, LLM_MODEL, opts);
  } catch (err) {
    if (/limit|quota|neuron|429|capacity|unavailable/i.test(String(err)) || titles.length < 2) throw err;
    const mid = Math.ceil(titles.length / 2);
    return [...await rewriteTitles(env, titles.slice(0, mid), LLM_MODEL, opts), ...await rewriteTitles(env, titles.slice(mid), LLM_MODEL, opts)];
  }
}

// Quota d'IA gratuit du compte Cloudflare : 10 000 neurons par jour, partagé entre la traduction des titres et la
// lecture des photos (vision.js). Compté en neurons réels (renvoyés par Workers AI) dans la 1re base, même quand la
// traduction tourne sur chaque base du catalogue (voir shard.js). La traduction s'arrête à TRANSLATE_NEURONS pour
// laisser de quoi lire les photos postées.
export const AI_NEURONS_PER_DAY = 9500;
const TRANSLATE_NEURONS = 8000;
const NEURONS_PER_TITLE = 0.7; // estimation si la réponse ne donne pas le chiffre

export async function aiNeurons(env) {
  const db = env.MAIN || env.DB;
  const day = new Date().toISOString().slice(0, 10);
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'ai_neurons'").first();
  let used = 0;
  try { const v = JSON.parse(row ? row.value : '{}'); used = v.day === day ? v.used : 0; } catch {}
  return {
    used,
    add: (n) => db.prepare(
      `INSERT INTO settings (key, value) VALUES ('ai_neurons', json_object('day', ?1, 'used', ?2))
       ON CONFLICT(key) DO UPDATE SET value = json_object('day', ?1, 'used',
         CASE WHEN json_extract(settings.value, '$.day') = ?1 THEN json_extract(settings.value, '$.used') ELSE 0 END + ?2)`,
    ).bind(day, n).run(),
  };
}

// Traduit un lot d'items sans titre anglais. Renvoie le nombre traduit.
export async function translatePending(env, limit) {
  const budget = await aiNeurons(env);
  if (budget.used >= TRANSLATE_NEURONS) return 0;
  const { results } = await env.DB.prepare(
    `SELECT id, title_zh, translate_failed FROM items
     WHERE title_en IS NULL AND translate_failed < 3 AND title_zh IS NOT NULL
       -- d'abord le titre anglais gratuit de la page produit ; sans elle au bout d'un moment, l'IA traduit quand même
       AND (platform != 'weidian' OR images IS NOT NULL OR first_seen < ?)
     LIMIT ?`, // pas de tri : on ne lit que les lignes traitées (quota de lectures D1)
  ).bind(Date.now() - titleWait(env), limit).all();
  let done = 0;
  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    let titles;
    try {
      const usage = [];
      titles = await rewriteInHalves(env, batch.map((it) => it.title_zh), usage);
      const spent = usage.reduce((n, u) => n + (u && u.neurons ? u.neurons : 0), 0);
      await budget.add(Math.round((spent || batch.length * NEURONS_PER_TITLE) * 100) / 100);
    } catch (err) {
      const msg = String(err);
      console.log('titres (modèle de langage)', msg.slice(0, 200));
      // Quota épuisé : plus d'essai aujourd'hui, sans pénaliser les items.
      if (/4006|daily free allocation/i.test(msg)) { await budget.add(AI_NEURONS_PER_DAY); break; }
      if (/limit|quota|neuron|429|capacity|unavailable/i.test(msg)) break;
      // Sinon on réessaie au prochain passage ; traduction mot à mot seulement après 2 échecs.
      const out = await Promise.allSettled(batch.map((it) => (it.translate_failed >= 2
        ? translate(env, it.title_zh, 'zh', 'en')
        : Promise.reject(new Error('à réessayer')))));
      titles = out.map((r) => (r.status === 'fulfilled' ? tidyTitle(r.value) : null));
    }
    // Un item classé « autre » faute de titre anglais est recatégorisé avec le nouveau titre.
    const stmts = batch.map((it, j) => (titles[j]
      ? env.DB.prepare("UPDATE items SET title_en = ?, category = CASE WHEN category = 'other' THEN NULL ELSE category END WHERE id = ?").bind(titles[j], it.id)
      : env.DB.prepare('UPDATE items SET translate_failed = translate_failed + 1 WHERE id = ?').bind(it.id)));
    await env.DB.batch(stmts);
    done += titles.filter(Boolean).length;
  }
  return done;
}

// Délai pendant lequel on attend le titre anglais gratuit de la page produit (réglable pour les tests).
export function titleWait(env) {
  return Number(env.TITLE_WAIT_MS ?? 30 * 60000);
}
