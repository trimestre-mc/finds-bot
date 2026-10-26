// Titres : un modèle de langage (Workers AI, quota gratuit) réécrit les titres chinois des vendeurs
// en titres produit courts et propres en anglais. m2m100 sert de secours.

const MT_MODEL = '@cf/meta/m2m100-1.2b';
const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const BATCH = 12;

export async function translate(env, text, from, to) {
  if (!text || !text.trim()) return '';
  const out = await env.AI.run(MT_MODEL, { text, source_lang: from, target_lang: to });
  return (out && out.translated_text ? out.translated_text : '').trim();
}

const SYSTEM = `You turn messy Chinese marketplace listing titles into clean English product titles for a shopping catalog.
For each title:
- Write 3 to 8 words in Title Case: [Brand if explicitly present] + [model/collection code if present] + [color if given] + [item type].
- Item type must be exact: 手镯 = bracelet, 项链 = necklace, 戒指 = ring, 墨镜 = sunglasses, 卫衣 = hoodie/sweatshirt, 短袖/T恤/tee = tee, 长袖 = long sleeve tee, 短裤 = shorts, 牛仔裤 = jeans, 夹克 = jacket, 外套 = jacket/coat, 针织 = knit.
- NEVER invent or guess a brand. Only use a brand that is clearly written (Latin letters like BAL, Sup, ALO, Acne, Ralph Lauren) or one of these exact nicknames: 双b/巴黎 = Balenciaga, 小香 = Chanel, 小马 = Ralph Lauren, 某b = Burberry. If no brand is clear, write no brand.
- Drop seller names and shop slogans (XX出品, XXmade, Rain Made, 杰尼龟, 我是呼吸, 自主, 现货, 发出, 库存, 不退换, 到货转寄, celebrity names, internal codes like #H134), and fabric/process details.
Reply with ONLY a JSON array of strings, same order and same count as the input.`;

// Nettoie un titre déjà en anglais (au cas où le modèle ajoute des guillemets ou de la ponctuation).
export function tidyTitle(t) {
  return String(t || '')
    .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
    .replace(/\s*[\/|]+\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 120)
    .trim();
}

export async function rewriteTitles(env, titles) {
  const res = await env.AI.run(LLM_MODEL, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(titles) },
    ],
    max_tokens: 60 + titles.length * 30,
    temperature: 0.2,
  });
  const raw = typeof res.response === 'string' ? res.response : JSON.stringify(res.response);
  const match = raw.match(/\[[\s\S]*\]/);
  const arr = match ? JSON.parse(match[0]) : null;
  if (!Array.isArray(arr) || arr.length !== titles.length) throw new Error(`réponse inattendue: ${raw.slice(0, 120)}`);
  return arr.map(tidyTitle);
}

// Le modèle renvoie parfois une liste vide ou incomplète : on réessaie en deux moitiés.
async function rewriteInHalves(env, titles) {
  try {
    return await rewriteTitles(env, titles);
  } catch (err) {
    if (/limit|quota|neuron|429|capacity|unavailable/i.test(String(err)) || titles.length < 2) throw err;
    const mid = Math.ceil(titles.length / 2);
    return [...await rewriteTitles(env, titles.slice(0, mid)), ...await rewriteTitles(env, titles.slice(mid))];
  }
}

// Traduit un lot d'items sans titre anglais. Renvoie le nombre traduit.
export async function translatePending(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT id, title_zh, translate_failed FROM items
     WHERE title_en IS NULL AND translate_failed < 3 AND title_zh IS NOT NULL
     ORDER BY first_seen DESC LIMIT ?`,
  ).bind(limit).all();
  let done = 0;
  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    let titles;
    try {
      titles = await rewriteInHalves(env, batch.map((it) => it.title_zh));
    } catch (err) {
      const msg = String(err);
      console.log('titres (modèle de langage)', msg.slice(0, 200));
      // Quota épuisé : on réessaiera plus tard sans pénaliser les items.
      if (/limit|quota|neuron|429|capacity|unavailable/i.test(msg)) break;
      // Sinon on réessaie au prochain passage ; traduction mot à mot seulement après 2 échecs.
      const out = await Promise.allSettled(batch.map((it) => (it.translate_failed >= 2
        ? translate(env, it.title_zh, 'zh', 'en')
        : Promise.reject(new Error('à réessayer')))));
      titles = out.map((r) => (r.status === 'fulfilled' ? tidyTitle(r.value) : null));
    }
    const stmts = batch.map((it, j) => (titles[j]
      ? env.DB.prepare('UPDATE items SET title_en = ? WHERE id = ?').bind(titles[j], it.id)
      : env.DB.prepare('UPDATE items SET translate_failed = translate_failed + 1 WHERE id = ?').bind(it.id)));
    await env.DB.batch(stmts);
    done += titles.filter(Boolean).length;
  }
  return done;
}
