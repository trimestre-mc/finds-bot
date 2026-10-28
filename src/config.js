// Réglages du bot (⚙️ dans le panneau) : devise, langue des cartes, couleur, salon par défaut, anti-doublon.

export const CURRENCIES = {
  EUR: { symbol: '€', after: true, comma: true, label: 'Euro (€)' },
  USD: { symbol: '$', label: 'Dollar US ($)' },
  GBP: { symbol: '£', label: 'Livre (£)' },
  CAD: { symbol: 'CA$', label: 'Dollar canadien (CA$)' },
  AUD: { symbol: 'A$', label: 'Dollar australien (A$)' },
  CHF: { symbol: 'CHF', after: true, label: 'Franc suisse (CHF)' },
};

export const ACCENTS = {
  orange: { color: 0xf97316, label: 'Orange', emoji: '🟧' },
  violet: { color: 0x8b5cf6, label: 'Violet', emoji: '🟪' },
  bleu: { color: 0x3b82f6, label: 'Bleu', emoji: '🟦' },
  vert: { color: 0x22c55e, label: 'Vert', emoji: '🟩' },
  rouge: { color: 0xef4444, label: 'Rouge', emoji: '🟥' },
  or: { color: 0xf0b232, label: 'Or', emoji: '🟨' },
  noir: { color: 0x111827, label: 'Noir', emoji: '⬛' },
};

export const LANGS = {
  fr: {
    label: 'Français', buy: (a) => `Acheter sur ${a}`, view: (p) => `Voir l'annonce ${p}`,
    sold: (n) => `${n} ventes`, noPrice: 'Prix sur l\'annonce', drop: (p) => `Prix en baisse, auparavant ${p}`,
  },
  en: {
    label: 'English', buy: (a) => `Buy on ${a}`, view: (p) => `View on ${p}`,
    sold: (n) => `${n} sold`, noPrice: 'Price on listing', drop: (p) => `Price lowered, previously ${p}`,
  },
};

export const DEFAULTS = { currency: 'EUR', lang: 'fr', accent: 'orange', defaultChannel: null, defaultChannelType: 0, dedupeDays: 7, forumQc: 1, weeklyTop: null };
const KEYS = Object.keys(DEFAULTS);

export async function getConfig(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'cfg_%'").all();
  const cfg = { ...DEFAULTS };
  for (const r of results) {
    const k = r.key.slice(4);
    if (!KEYS.includes(k)) continue;
    cfg[k] = typeof DEFAULTS[k] === 'number' ? Number(r.value) : r.value;
  }
  if (!CURRENCIES[cfg.currency]) cfg.currency = DEFAULTS.currency;
  if (!LANGS[cfg.lang]) cfg.lang = DEFAULTS.lang;
  if (!ACCENTS[cfg.accent]) cfg.accent = DEFAULTS.accent;
  return cfg;
}

// Bouton « S'inscrire » sous les items. Discord ne colore pas les boutons-liens : gris = lien direct (1 clic),
// les autres couleurs ouvrent une petite fenêtre avec le lien (2 clics).
export const SIGNUP_COLORS = {
  gris: { style: 5, label: 'Gris (lien direct, 1 clic)', emoji: '⬜' },
  bleu: { style: 1, label: 'Bleu (2 clics)', emoji: '🟦' },
  vert: { style: 3, label: 'Vert (2 clics)', emoji: '🟩' },
  rouge: { style: 4, label: 'Rouge (2 clics)', emoji: '🟥' },
};

export async function getSignup(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'signup'").first();
  try {
    const s = row ? JSON.parse(row.value) : null;
    return s && /^https:\/\//.test(s.url || '') ? { color: 'vert', ...s } : null;
  } catch { return null; }
}

export async function setSignup(env, value) {
  if (!value) await env.DB.prepare("DELETE FROM settings WHERE key = 'signup'").run();
  else await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('signup', ?)").bind(JSON.stringify(value)).run();
}

// Message de /coupon : titre, texte et jusqu'à 5 liens (texte + adresse), choisis par le propriétaire.
export async function getCoupon(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'coupon'").first();
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}

export async function setCoupon(env, value) {
  if (!value) await env.DB.prepare("DELETE FROM settings WHERE key = 'coupon'").run();
  else await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('coupon', ?)").bind(JSON.stringify(value)).run();
}

// Lignes « Texte | https://… » (une par lien) → [{ label, url }] ; les lignes invalides sont ignorées.
export function parseCouponLinks(raw) {
  return String(raw || '').split('\n').map((line) => {
    const m = line.match(/^\s*(.*?)\s*[|:–-]?\s*(https:\/\/\S+)\s*$/);
    if (!m) return null;
    return { label: (m[1] || 'Ouvrir').slice(0, 80), url: m[2] };
  }).filter(Boolean).slice(0, 5);
}

export async function setConfig(env, key, value) {
  if (!KEYS.includes(key)) throw new Error(`réglage inconnu : ${key}`);
  if (value == null) await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`cfg_${key}`).run();
  else await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(`cfg_${key}`, String(value)).run();
}

// Taux CNY → devise choisie. money = { rate, code } ; rate sert aussi aux filtres de prix de la recherche.
export async function getMoney(env, cfg) {
  cfg = cfg || await getConfig(env);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'rates'").first();
  let rates = {};
  try { rates = row ? JSON.parse(row.value) : {}; } catch {}
  const legacy = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cny_eur'").first();
  const fallback = { eur: legacy ? parseFloat(legacy.value) : 0.13, usd: 0.14, gbp: 0.11, cad: 0.19, aud: 0.21, chf: 0.12 };
  const rate = Number(rates[cfg.currency.toLowerCase()]) || fallback[cfg.currency.toLowerCase()] || 0.13;
  return { rate, code: cfg.currency };
}

export function formatMoney(cny, money) {
  const c = CURRENCIES[money.code] || CURRENCIES.EUR;
  const v = (cny * money.rate).toFixed(2);
  const n = c.comma ? v.replace('.', ',') : v;
  return c.after ? `${n} ${c.symbol}` : `${c.symbol}${n}`;
}

export function formatCny(cny) {
  return `¥${Number(cny).toFixed(cny % 1 ? 2 : 0)}`;
}

// Taux de change (toutes devises), rafraîchis toutes les 6 h.
export async function refreshRates(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'rates_at'").first();
  if (row && Date.now() - Number(row.value) < 6 * 3600 * 1000) return;
  const res = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json');
  if (!res.ok) return;
  const data = await res.json();
  if (!data || !data.cny || !data.cny.eur) return;
  const keep = Object.fromEntries(Object.keys(CURRENCIES).map((c) => [c.toLowerCase(), data.cny[c.toLowerCase()]]));
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rates', ?)").bind(JSON.stringify(keep)),
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cny_eur', ?)").bind(String(data.cny.eur)),
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rates_at', ?)").bind(String(Date.now())),
  ]);
}
