// Budgets d'écriture : par jour et par type de travail, plus un plafond mensuel global (base Turso gratuite :
// 10 millions de lignes écrites par mois, index compris).
// Un item ajouté ou modifié écrit ~8 lignes (table + index), une page produit (photos, titre) ~4, une catégorie ~3.
// Avec le plafond mensuel, chaque jour reçoit sa part : (reste du mois) ÷ (jours restants), répartie entre les
// types de travail. On indexe ainsi tous les jours au lieu de tout dépenser en quelques jours puis s'arrêter.

// Valeurs pour D1 gratuit ; plus grandes avec Turso (variables BUDGET_ITEMS, BUDGET_PAGES, BUDGET_CATEGORIZE, BUDGET_QCSYNC).
const CAPS = { items: 5000, pages: 3000, categorize: 12000, qcsync: 2000 };
const ROWS = { items: 8, pages: 4, categorize: 3, qcsync: 8 };
// Part de la journée pour chaque type de travail (le reste non utilisé passe au lendemain).
const SHARE = { items: 0.4, qcsync: 0.3, pages: 0.2, categorize: 0.1 };
// Les budgets agrandis ne valent que si Turso est réellement branché (sinon retour aux limites de D1).
const cap = (env, kind) => (env.TURSO_URL && Number(env[`BUDGET_${kind.toUpperCase()}`])) || CAPS[kind];
// Plafond mensuel (lignes estimées) : on garde une marge pour les posts, clics et QC, qui ne sont pas budgétés.
const monthCap = (env) => (env.TURSO_URL && Number(env.BUDGET_MONTH_ROWS)) || 0;

// Part du jour : ce qui restait du mois ce matin, divisé par les jours restants (aujourd'hui compris).
export function dailyRows(capRows, startRows, date = new Date()) {
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = daysInMonth - date.getUTCDate() + 1;
  return Math.max(0, Math.floor((capRows - startRows) / daysLeft));
}

export async function budget(env, kind) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const key = `budget:${kind}`;
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN (?, 'budget:month')").bind(key).all();
  const read = (k) => { try { return JSON.parse((results.find((r) => r.key === k) || {}).value || '{}'); } catch { return {}; } };
  const d = read(key);
  const m = read('budget:month');
  const used = d.day === day ? d.used : 0;
  const monthUsed = m.month === month ? m.rows : 0;
  let left = Math.max(0, cap(env, kind) - used);
  if (monthCap(env)) {
    const start = m.month === month && m.day === day && m.start != null ? m.start : monthUsed;
    const today = Math.floor(dailyRows(monthCap(env), start, now) * SHARE[kind] / ROWS[kind]);
    left = Math.min(left, Math.max(0, today - used), Math.max(0, Math.floor((monthCap(env) - monthUsed) / ROWS[kind])));
  }
  return {
    left,
    use: (n) => {
      const stmts = [env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .bind(key, JSON.stringify({ day, used: used + n }))];
      if (monthCap(env) && n) {
        // Ajout atomique au compteur du mois (plusieurs tâches peuvent tourner en même temps). « start » garde le
        // total du mois au début de la journée, pour calculer la part du jour.
        stmts.push(env.DB.prepare(
          `INSERT INTO settings (key, value) VALUES ('budget:month', json_object('month', ?1, 'rows', ?2, 'day', ?3, 'start', 0))
           ON CONFLICT(key) DO UPDATE SET value = (SELECT json_object('month', ?1, 'rows', old + ?2, 'day', ?3,
               'start', CASE WHEN json_extract(settings.value, '$.day') = ?3 THEN json_extract(settings.value, '$.start') ELSE old END)
             FROM (SELECT CASE WHEN json_extract(settings.value, '$.month') = ?1 THEN json_extract(settings.value, '$.rows') ELSE 0 END AS old))`,
        ).bind(month, n * ROWS[kind], day));
      }
      return env.DB.batch(stmts);
    },
  };
}
