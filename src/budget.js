// Budgets d'écriture quotidiens (plan gratuit D1 : 100 000 lignes écrites par jour, index compris).
// Un item ajouté ou modifié écrit ~7 lignes (table + index), une page produit (photos, titre) ~4, une catégorie ~3.
// Répartition (~95 000 lignes) : items 35 000, catégories 36 000, pages 12 000, le reste pour posts, clics, QC.
// Au-delà du budget, le travail reprend le lendemain (minuit UTC).

// Valeurs pour D1 gratuit ; plus grandes avec Turso (variables BUDGET_ITEMS, BUDGET_PAGES, BUDGET_CATEGORIZE).
const CAPS = { items: 5000, pages: 3000, categorize: 12000 };
// Les budgets agrandis ne valent que si Turso est réellement branché (sinon retour aux limites de D1).
const cap = (env, kind) => (env.TURSO_URL && Number(env[`BUDGET_${kind.toUpperCase()}`])) || CAPS[kind];

export async function budget(env, kind) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `budget:${kind}`;
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  let used = 0;
  try { const v = JSON.parse(row ? row.value : '{}'); used = v.day === day ? v.used : 0; } catch {}
  return {
    left: Math.max(0, cap(env, kind) - used),
    use: (n) => env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind(key, JSON.stringify({ day, used: used + n })).run(),
  };
}
