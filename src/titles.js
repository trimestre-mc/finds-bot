// Titres lisibles : les titres traduits des vendeurs sont pleins de jargon (« Cross-Border In-Stock High Version Putian
// Factory… ») et de noms de marque codés (« Aj4 », « N*K », « Crow Heart »). On les nettoie pour l'affichage (fiches,
// recherche, posts) ; le titre d'origine reste dans la base et sert toujours à la recherche.

// Jargon de vendeur, retiré partout dans le titre.
const NOISE = [
  /【[^】]*】/g, /\[[^\]]*\]/g, /\bID\s*[:：]\s*\d+/gi,
  /\bcross[- ]border( e-?commerce)?\b/gi, /\bforeign trade\b/gi, /\bin[- ]stock\b/gi, /\bspot goods?\b/gi, /\bwholesale\b/gi,
  /\bhot[- ]selling\b/gi, /\bbig sale\b/gi, /\bleakage counter withdraws\b/gi, /\bdropshipping\b/gi, /\bexport[- ]grade\b/gi,
  /\bhigh[- ](quality|end|version)\b/gi, /\btop (version|quality)\b/gi, /\b(correct|original|authentic|pure original|1:1) version( of)?\b/gi,
  /\bfactory direct( sales)?\b/gi, /\bputian( factory| shoes?)?\b/gi, /\boriginal (box|label)( branded)?\b/gi,
  /\bamerican[- ](trendy brand|style)\b/gi, /\btrendy brand\b/gi, /\bfashion brand\b/gi, /\bpopular\b/gi, /\bnew (style|arrival)\b/gi,
  /\bfor (men and women|men & women|women and men)\b/gi, /\bmen'?s and women'?s\b/gi, /\bcouple( style| dress)?\b/gi, /\bunisex\b/gi,
  /\b20(2[0-9]|1[0-9]) (new|spring|autumn|winter|summer)\b/gi, /\bversatile\b/gi, /\bins\b/gi,
];

// Noms de marque et de modèle codés par les vendeurs → leur vrai nom.
const NAMES = [
  [/\baj ?(\d{1,2})\b/gi, (_, n) => `Air Jordan ${n}`], [/\bn\*k\b/gi, 'Nike'], [/\bnk\b/g, 'Nike'], [/\bNK\b/g, 'Nike'],
  [/\bcrow hearts?\b/gi, 'Chrome Hearts'], [/\bchrome heart\b/gi, 'Chrome Hearts'], [/\bb\.?arce1on\b/gi, 'Barcelona'],
  [/\bi\.tal\b/gi, 'Italy'], [/\bmengjia|mengkou\b/gi, 'Moncler'], [/\bnew bailun\b/gi, 'New Balance'], [/\bnb ?(\d{3,4})\b/gi, (_, n) => `New Balance ${n}`],
  [/\bm brand\b/gi, 'Moncler'], [/\bb brand\b/gi, 'Balenciaga'], [/\bl brand\b/gi, 'Louis Vuitton'], [/\bg brand\b/gi, 'Gucci'],
];

export function cleanTitle(raw, max = 100) {
  const original = String(raw || '').trim();
  let t = original;
  for (const re of NOISE) t = t.replace(re, ' ');
  for (const [re, to] of NAMES) t = t.replace(re, to);
  t = t.replace(/\s+([,;])/g, '$1').replace(/\s*[,;/|]+\s*(?=[,;/|]|$)/g, ' ').replace(/^[\s,;:\-–—/|·.]+|[\s,;:\-–—/|·]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  // Trop abîmé par le nettoyage : le titre d'origine.
  if (t.length < 6) t = original;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > max ? `${t.slice(0, max - 1).replace(/[\s,;:-]+\S*$/, '')}…` : t;
}

// Produit pour adultes (FinderQC le signale aussi) : jamais montré.
export const ADULT = /\b(sex ?(doll|toy)s?|adult products?|vibrator|dildo|masturbat\w*|inverted mold|erotic|lingerie sexy)\b/i;
