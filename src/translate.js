// Traduction via Workers AI (modèle m2m100, gratuit dans le quota journalier).

const MODEL = '@cf/meta/m2m100-1.2b';

export async function translate(env, text, from, to) {
  if (!text || !text.trim()) return '';
  const out = await env.AI.run(MODEL, { text, source_lang: from, target_lang: to });
  return (out && out.translated_text ? out.translated_text : '').trim();
}

// Traduit un lot d'items sans titre anglais. Renvoie le nombre traduit.
export async function translatePending(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT id, title_zh FROM items
     WHERE title_en IS NULL AND translate_failed < 3 AND title_zh IS NOT NULL
     ORDER BY first_seen DESC LIMIT ?`,
  ).bind(limit).all();
  let done = 0;
  for (const it of results) {
    try {
      const en = await translate(env, it.title_zh, 'zh', 'en');
      await env.DB.prepare('UPDATE items SET title_en = ? WHERE id = ?').bind(en || it.title_zh, it.id).run();
      done++;
    } catch (err) {
      const msg = String(err);
      console.log('traduction échouée', it.id, msg.slice(0, 200));
      // Quota épuisé ou modèle indisponible : on réessaiera plus tard sans pénaliser l'item.
      if (!/limit|quota|neuron|429|capacity|unavailable/i.test(msg)) {
        await env.DB.prepare('UPDATE items SET translate_failed = translate_failed + 1 WHERE id = ?').bind(it.id).run();
      }
      break;
    }
  }
  return done;
}
