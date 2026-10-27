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

// Lignes réellement écrites par un lot (Turso et D1 les renvoient) ; null si la base ne les donne pas.
export function rowsWritten(results) {
  let total = 0;
  for (const r of results || []) {
    const n = r && r.meta && r.meta.rows_written;
    if (typeof n !== 'number') return null;
    total += n;
  }
  return total;
}

// Plafond de LECTURES du mois (Turso gratuit : 500 M). Au-delà, plus de travail de fond : il reste de quoi
// répondre sur Discord jusqu'au 1er du mois suivant.
const readsCap = (env) => (env.TURSO_URL && Number(env.READS_MONTH_CAP)) || 0;

export async function readsOver(env) {
  if (!readsCap(env)) return false;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'reads:month'").first();
  return readsOverValue(env, row && row.value);
}

function readsOverValue(env, value) {
  try {
    const r = JSON.parse(value || '{}');
    return r.month === new Date().toISOString().slice(0, 7) && r.rows >= readsCap(env);
  } catch { return false; }
}

// Ajoute au compteur du mois les lignes lues pendant cette exécution (une écriture par exécution).
export async function recordReads(env) {
  // Chaque base du catalogue tient son propre compteur (voir shard.js).
  await Promise.all([env.DB, env.DB2].filter(Boolean).map((db) => recordReadsOn(env, db)));
}

async function recordReadsOn(env, db) {
  const n = db.rowsRead;
  if (!readsCap(env) || !n) return;
  db.rowsRead = 0;
  const month = new Date().toISOString().slice(0, 7);
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES ('reads:month', json_object('month', ?1, 'rows', ?2))
     ON CONFLICT(key) DO UPDATE SET value = json_object('month', ?1, 'rows',
       CASE WHEN json_extract(settings.value, '$.month') = ?1 THEN json_extract(settings.value, '$.rows') ELSE 0 END + ?2)`,
  ).bind(month, n).run().catch(() => {});
}

export async function budget(env, kind) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const key = `budget:${kind}`;
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN (?, 'budget:month', 'reads:month')").bind(key).all();
  const read = (k) => { try { return JSON.parse((results.find((r) => r.key === k) || {}).value || '{}'); } catch { return {}; } };
  const d = read(key);
  const m = read('budget:month');
  const used = d.day === day ? d.used : 0;
  const monthUsed = m.month === month ? m.rows : 0;
  let left = Math.max(0, cap(env, kind) - used);
  if (readsOverValue(env, (results.find((r) => r.key === 'reads:month') || {}).value)) left = 0;
  if (monthCap(env)) {
    const start = m.month === month && m.day === day && m.start != null ? m.start : monthUsed;
    const today = Math.floor(dailyRows(monthCap(env), start, now) * SHARE[kind] / ROWS[kind]);
    left = Math.min(left, Math.max(0, today - used), Math.max(0, Math.floor((monthCap(env) - monthUsed) / ROWS[kind])));
  }
  return {
    left,
    // n : unités de travail (items, pages…) ; rows : lignes vraiment écrites si connues (un item inchangé n'écrit
    // rien), sinon l'estimation n × ROWS. Le budget du jour est compté en lignes ramenées en unités.
    use: (n, rows = null) => {
      const real = rows != null ? rows : n * ROWS[kind];
      const units = Math.round((real / ROWS[kind]) * 100) / 100;
      const stmts = [env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .bind(key, JSON.stringify({ day, used: used + units }))];
      if (monthCap(env) && real) {
        // Ajout atomique au compteur du mois (plusieurs tâches peuvent tourner en même temps). « start » garde le
        // total du mois au début de la journée, pour calculer la part du jour.
        stmts.push(env.DB.prepare(
          `INSERT INTO settings (key, value) VALUES ('budget:month', json_object('month', ?1, 'rows', ?2, 'day', ?3, 'start', 0))
           ON CONFLICT(key) DO UPDATE SET value = (SELECT json_object('month', ?1, 'rows', old + ?2, 'day', ?3,
               'start', CASE WHEN json_extract(settings.value, '$.day') = ?3 THEN json_extract(settings.value, '$.start') ELSE old END)
             FROM (SELECT CASE WHEN json_extract(settings.value, '$.month') = ?1 THEN json_extract(settings.value, '$.rows') ELSE 0 END AS old))`,
        ).bind(month, real, day));
      }
      return env.DB.batch(stmts);
    },
  };
}
