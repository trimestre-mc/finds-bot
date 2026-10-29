// Chien de garde : prévient le propriétaire en MP dès qu'un service ou un quota approche de sa limite, avant que le
// bot casse (le 28/10, quotas D1, FinderQC et limite de requêtes ont cassé le bot sans prévenir). Au plus un MP toutes
// les 6 h par problème. Vérifications toutes les 15 min (checkHealth) et au moment d'une erreur (alertOwner).

import { container, text } from './components.js';
import { discordApi } from './discord.js';
import { redis, kvGet, kvMany, neon } from './kvstore.js';

const QUIET_S = 6 * 3600;
const memo = new Map();

// MP au propriétaire pour un problème (clé), sauf s'il a déjà été prévenu dans les 6 dernières heures.
export async function alertOwner(env, key, title, detail) {
  if (!env.AGENTS_OWNER_ID) return false;
  const r = await redis(env, [['SET', `alert:${key}`, '1', 'NX', 'EX', String(QUIET_S)]]);
  if (r && r[0] !== 'OK') return false; // déjà prévenu
  // Upstash ne répond pas (ou son quota est atteint) : on se souvient ici, au moins pour cette exécution.
  if (!r) {
    if (memo.get(key) > Date.now()) return false;
    memo.set(key, Date.now() + QUIET_S * 1000);
  }
  try {
    const dm = await discordApi(env, 'POST', '/users/@me/channels', { recipient_id: env.AGENTS_OWNER_ID });
    await discordApi(env, 'POST', `/channels/${dm.id}/messages`, {
      flags: 32768, allowed_mentions: { parse: [] },
      components: [container([text(`## ⚠️ ${title}\n${detail}\n-# Chien de garde du bot · prochain rappel pour ce problème dans 6 h au plus tôt.`)], 0xf59e0b)],
    });
    return true;
  } catch (err) {
    console.log('chien de garde (MP)', String(err).slice(0, 120));
    return false;
  }
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

// Toutes les 15 min : état des services et des quotas. Renvoie la liste des problèmes trouvés.
export async function checkHealth(env) {
  const found = [];
  const day = new Date().toISOString().slice(0, 10);
  const kv = await kvMany(env, ['gateway:alive', 'groq:rest', `ai_neurons:${day}`, 'fqc:busy', `stat:error:${day}`]);
  // Upstash ne répond pas : compteurs, verrous et limites retombent sur la base, et son quota est peut-être atteint.
  if (!Object.keys(kv).length && env.UPSTASH_URL) {
    found.push(['upstash', 'Upstash ne répond pas', 'Quota du mois atteint ou panne : le bot repasse sur la base pour les compteurs et les caches (plus de lectures et d\'écritures). Regarde console.upstash.com → Usage.']);
  }

  // Connexion directe à Discord : sans signal depuis 6 min, les salons ne sont plus traités en direct.
  const alive = Number(kv['gateway:alive']) || 0;
  if (env.GATEWAY && alive && Date.now() - alive > 6 * 60000) {
    found.push(['gateway', 'Connexion Discord tombée', `Plus de signal depuis ${Math.round((Date.now() - alive) / 60000)} min. La relecture de secours des salons a pris le relais (réponses plus lentes).`]);
  }

  // Base de secours D1 : lectures ou écritures du jour épuisées.
  const d1 = await env.DB.prepare('SELECT 1 AS ok FROM settings LIMIT 1').first().then(() => null).catch((e) => String(e));
  if (d1) found.push(['d1', 'Base D1 illisible', `Le quota du jour est probablement atteint (remise à zéro à minuit UTC). Le bot tourne en mode réduit.\n-# ${d1.slice(0, 160)}`]);

  // Neon : place de l'index de recherche (0,5 Go par projet).
  if (env.NEON_URL) {
    const { neonParts } = await import('./searchindex.js');
    for (const pe of neonParts(env)) {
      const n = pe.NEON_PART || 1;
      const [r] = await neon(pe, 'SELECT pg_database_size(current_database()) AS b').catch(() => [null]);
      const used = r ? Number(r.b) : 0;
      if (pct(used, 512 * 1024 * 1024) >= 85) found.push([`neon-${n}`, `Neon ${n} presque plein`, `${Math.round(used / 1048576)} Mo sur 512 Mo dans le projet Neon ${n} (index de recherche). Il faut un projet Neon de plus.`]);
    }
  }

  // Turso : écritures et lectures du mois, pour chaque base Turso.
  for (const [name, db] of [['base 1', env.DB && !env.DB.isD1 ? env.DB : null], ['base 2', env.DB2]]) {
    if (!db) continue;
    const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('budget:month', 'reads:month')").all().then((x) => x.results).catch(() => []);
    const read = (k) => { try { return JSON.parse((rows.find((x) => x.key === k) || {}).value || '{}'); } catch { return {}; } };
    const month = new Date().toISOString().slice(0, 7);
    const w = read('budget:month');
    const rd = read('reads:month');
    const wCap = Number(env.BUDGET_MONTH_ROWS) || 9000000;
    const rCap = Number(env.READS_MONTH_CAP) || 480000000;
    if (w.month === month && pct(w.rows, wCap) >= 85) found.push([`turso-w-${name}`, `Turso ${name} : écritures du mois à ${pct(w.rows, wCap)} %`, `${w.rows.toLocaleString('fr-FR')} lignes sur ${wCap.toLocaleString('fr-FR')}. L'indexation va ralentir puis s'arrêter jusqu'au mois prochain.`]);
    if (rd.month === month && pct(rd.rows, rCap) >= 80) found.push([`turso-r-${name}`, `Turso ${name} : lectures du mois à ${pct(rd.rows, rCap)} %`, `${rd.rows.toLocaleString('fr-FR')} lignes lues (compteur du bot, qui sous-estime). Au-delà de 500 M, Turso bloque la base jusqu'au mois prochain.`]);
  }

  // IA du jour : Groq au repos et quota Cloudflare épuisé → plus d'analyse IA rapide.
  const neurons = Number(kv[`ai_neurons:${day}`]) || 0;
  if (Number(kv['groq:rest']) > Date.now() && neurons >= 9000) {
    found.push(['ia', 'IA du jour presque épuisée', 'Groq a atteint sa limite du jour et le quota Cloudflare est presque vide : les analyses passent par OVH (plus lent) ou échouent jusqu\'à demain.']);
  }

  // FinderQC limite le bot : recherche par image et synchro en pause.
  if (Number(kv['fqc:busy']) > Date.now()) found.push(['finderqc', 'FinderQC limite le bot', 'Trop de requêtes : la synchro du catalogue est en pause, la recherche par image passe par l\'index du bot.']);

  // Pic d'erreurs dans la journée.
  const errors = Number(kv[`stat:error:${day}`]) || 0;
  if (errors >= 50) found.push(['errors', `${errors} erreurs aujourd'hui`, 'Regarde le fil d\'activité du dashboard (lignes « Erreur ») pour voir lesquelles.']);

  for (const [key, title, detail] of found) await alertOwner(env, key, title, detail);
  return found.map(([key, title]) => ({ key, title }));
}
