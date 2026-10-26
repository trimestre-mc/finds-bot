// Budgets d'écriture : par jour et par type de travail, plus un plafond mensuel global (base Turso gratuite :
// 10 millions de lignes écrites par mois, index compris).
// Un item ajouté ou modifié écrit ~8 lignes (table + index), une page produit (photos, titre) ~4, une catégorie ~3.
// Au-delà du budget du jour, le travail reprend le lendemain (minuit UTC) ; au-delà du plafond du mois, le 1er.

// Valeurs pour D1 gratuit ; plus grandes avec Turso (variables BUDGET_ITEMS, BUDGET_PAGES, BUDGET_CATEGORIZE, BUDGET_QCSYNC).
const CAPS = { items: 5000, pages: 3000, categorize: 12000, qcsync: 2000 };
const ROWS = { items: 8, pages: 4, categorize: 3, qcsync: 8 };
// Les budgets agrandis ne valent que si Turso est réellement branché (sinon retour aux limites de D1).
const cap = (env, kind) => (env.TURSO_URL && Number(env[`BUDGET_${kind.toUpperCase()}`])) || CAPS[kind];
// Plafond mensuel (lignes estimées) : on garde une marge pour les posts, clics et QC, qui ne sont pas budgétés.
const monthCap = (env) => (env.TURSO_URL && Number(env.BUDGET_MONTH_ROWS)) || 0;

export async function budget(env, kind) {
  const day = new Date().toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const key = `budget:${kind}`;
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN (?, 'budget:month')").bind(key).all();
  const read = (k) => { try { return JSON.parse((results.find((r) => r.key === k) || {}).value || '{}'); } catch { return {}; } };
  const d = read(key);
  const m = read('budget:month');
  const used = d.day === day ? d.used : 0;
  const monthUsed = m.month === month ? m.rows : 0;
  let left = Math.max(0, cap(env, kind) - used);
  if (monthCap(env)) left = Math.min(left, Math.max(0, Math.floor((monthCap(env) - monthUsed) / ROWS[kind])));
  return {
    left,
    use: (n) => {
      const stmts = [env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .bind(key, JSON.stringify({ day, used: used + n }))];
      if (monthCap(env) && n) {
        // Ajout atomique au compteur du mois (plusieurs tâches peuvent tourner en même temps).
        stmts.push(env.DB.prepare(
          `INSERT INTO settings (key, value) VALUES ('budget:month', json_object('month', ?, 'rows', ?))
           ON CONFLICT(key) DO UPDATE SET value = json_object('month', ?1,
             'rows', CASE WHEN json_extract(settings.value, '$.month') = ?1 THEN json_extract(settings.value, '$.rows') ELSE 0 END + ?2)`,
        ).bind(month, n * ROWS[kind]));
      }
      return env.DB.batch(stmts);
    },
  };
}
