// Budgets d'écriture quotidiens (plan gratuit D1 : 100 000 lignes écrites par jour, index compris).
// Un item ajouté ou modifié écrit ~7 lignes (table + index), une page produit (photos, titre) ~4, une catégorie ~3.
// Répartition (~95 000 lignes) : items 35 000, catégories 36 000, pages 12 000, le reste pour posts, clics, QC.
// Au-delà du budget, le travail reprend le lendemain (minuit UTC).

const CAPS = { items: 5000, pages: 3000, categorize: 12000 };

export async function budget(env, kind) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `budget:${kind}`;
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  let used = 0;
  try { const v = JSON.parse(row ? row.value : '{}'); used = v.day === day ? v.used : 0; } catch {}
  return {
    left: Math.max(0, CAPS[kind] - used),
    use: (n) => env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind(key, JSON.stringify({ day, used: used + n })).run(),
  };
}
