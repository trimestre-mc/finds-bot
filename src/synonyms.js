// Compréhension des recherches : chaque mot (ou expression) cherché devient un groupe d'équivalents, en anglais,
// en français et dans les mots des vendeurs chinois (« supreme tee » = Supreme/SUP + tee/t-shirt/T恤/短袖).
// Tous les groupes doivent correspondre. Les équivalents latins sont cherchés en mots entiers (« tee » ne trouve pas
// « steel », « sup » ne trouve pas « super »).

// Types d'article : mots, et catégorie correspondante (un item déjà classé dans la catégorie correspond aussi).
const TYPES = [
  { words: ['tee', 'tees', 't-shirt', 't-shirts', 'tshirt', 'tshirts', 't shirt', 'teeshirt', 'tee-shirt'], alt: ['tee', 't-shirt', 'tshirt', 't shirt', '短袖', 't恤'], cat: 'tees' },
  { words: ['polo', 'polos'], alt: ['polo'], cat: 'tees' },
  { words: ['hoodie', 'hoodies', 'sweat', 'sweatshirt', 'sweatshirts', 'hoody', 'crewneck'], alt: ['hoodie', 'hoody', 'sweatshirt', 'crewneck', 'pullover', '卫衣', '帽衫'], cat: 'hoodies' },
  { words: ['zip', 'zipup', 'zip-up'], alt: ['zip', '拉链'], cat: 'hoodies' },
  { words: ['sweater', 'sweaters', 'pull', 'pulls', 'knit', 'knitwear', 'cardigan', 'maille'], alt: ['sweater', 'knit', 'cardigan', 'jumper', '毛衣', '针织', '开衫'], cat: 'knit' },
  { words: ['shirt', 'shirts', 'chemise', 'chemises'], alt: ['shirt', 'button up', '衬衫'], cat: 'knit' },
  { words: ['jacket', 'jackets', 'veste', 'vestes', 'coat', 'manteau', 'blouson'], alt: ['jacket', 'coat', 'blouson', '夹克', '外套', '大衣'], cat: 'jackets' },
  { words: ['puffer', 'doudoune', 'down'], alt: ['puffer', 'down jacket', '羽绒'], cat: 'jackets' },
  { words: ['pants', 'trousers', 'pantalon', 'pantalons'], alt: ['pants', 'trousers', '裤'], cat: 'pants' },
  { words: ['jeans', 'jean', 'denim'], alt: ['jeans', 'denim', '牛仔'], cat: 'pants' },
  { words: ['shorts', 'short'], alt: ['shorts', '短裤'], cat: 'pants' },
  { words: ['joggers', 'jogger', 'jogging', 'sweatpants', 'trackpants'], alt: ['jogger', 'sweatpants', 'track pants', '卫裤', '运动裤'], cat: 'pants' },
  { words: ['tracksuit', 'survetement', 'survêtement', 'ensemble', 'set'], alt: ['tracksuit', 'set', '套装'], cat: null },
  { words: ['shoes', 'shoe', 'sneakers', 'sneaker', 'chaussures', 'chaussure', 'baskets', 'basket', 'trainers'], alt: ['shoe', 'sneaker', 'trainer', '鞋'], cat: 'shoes' },
  { words: ['boots', 'boot', 'bottes', 'botte'], alt: ['boot', '靴'], cat: 'shoes' },
  { words: ['slides', 'claquettes', 'sandals', 'sandales', 'slippers'], alt: ['slide', 'sandal', 'slipper', '拖鞋', '凉鞋'], cat: 'shoes' },
  { words: ['bag', 'bags', 'sac', 'sacs', 'backpack', 'tote', 'handbag'], alt: ['bag', 'backpack', 'tote', 'handbag', 'crossbody', '背包', '挎包', '手提包', '单肩包', '双肩包', '腋下包', '托特包', '女包', '男包'], cat: 'bags' },
  { words: ['wallet', 'wallets', 'portefeuille', 'cardholder'], alt: ['wallet', 'card holder', '钱包', '卡包'], cat: 'accessories' },
  { words: ['cap', 'caps', 'casquette', 'casquettes', 'hat', 'hats', 'chapeau'], alt: ['cap', 'hat', '帽子', '棒球帽', '鸭舌帽', '渔夫帽'], cat: 'accessories' },
  { words: ['beanie', 'bonnet'], alt: ['beanie', '毛线帽', '针织帽'], cat: 'accessories' },
  { words: ['belt', 'belts', 'ceinture'], alt: ['belt', '腰带', '皮带'], cat: 'accessories' },
  { words: ['sunglasses', 'lunettes', 'glasses'], alt: ['sunglasses', 'glasses', '墨镜', '眼镜'], cat: 'accessories' },
  { words: ['scarf', 'echarpe', 'écharpe'], alt: ['scarf', '围巾'], cat: 'accessories' },
  { words: ['socks', 'sock', 'chaussettes', 'chaussette'], alt: ['socks', 'sock', '袜'], cat: 'accessories' },
  { words: ['necklace', 'collier', 'chain', 'chaine', 'chaîne'], alt: ['necklace', 'chain', '项链'], cat: 'jewelry' },
  { words: ['bracelet', 'bracelets'], alt: ['bracelet', '手镯', '手链'], cat: 'jewelry' },
  { words: ['ring', 'rings', 'bague', 'bagues'], alt: ['ring', '戒指'], cat: 'jewelry' },
  { words: ['earrings', 'boucles'], alt: ['earring', '耳环', '耳钉'], cat: 'jewelry' },
  { words: ['watch', 'watches', 'montre', 'montres'], alt: ['watch', '手表'], cat: 'jewelry' },
  { words: ['bob', 'bucket', 'bucket hat'], alt: ['bucket hat', 'bucket', '渔夫帽'], cat: 'accessories' },
  { words: ['cagoule', 'balaclava'], alt: ['balaclava', '头套'], cat: 'accessories' },
  { words: ['gilet', 'vest', 'sans manche'], alt: ['vest', 'gilet', '马甲', '背心'], cat: 'jackets' },
  { words: ['sacoche', 'crossbody', 'messenger'], alt: ['crossbody', 'messenger bag', 'shoulder bag', '斜挎包'], cat: 'bags' },
  { words: ['banane', 'waist bag', 'bum bag'], alt: ['waist bag', 'belt bag', 'bum bag', '腰包', '胸包'], cat: 'bags' },
  { words: ['maillot', 'jersey', 'maillot de foot'], alt: ['jersey', '球衣'], cat: 'tees' },
  { words: ['debardeur', 'tank top', 'marcel'], alt: ['tank top', 'vest top', '背心'], cat: 'tees' },
  { words: ['parfum', 'perfume', 'fragrance'], alt: ['perfume', 'fragrance', 'cologne', '香水'], cat: 'tech' },
  { words: ['ecouteurs', 'airpods', 'earbuds'], alt: ['airpods', 'earbuds', 'headphones', '耳机'], cat: 'tech' },
  { words: ['coque', 'phone case'], alt: ['phone case', 'case', '手机壳'], cat: 'tech' },
  { words: ['mules', 'clogs', 'sabots'], alt: ['mule', 'clog', '穆勒', '洞洞鞋'], cat: 'shoes' },
];

// Marques : nom, surnoms et noms chinois des vendeurs (le même glossaire que la traduction des titres).
const BRANDS = [
  { words: ['supreme', 'sup'], alt: ['supreme', 'sup'] },
  { words: ['nike', 'nk'], alt: ['nike', 'nk', '耐克'] },
  { words: ['tech', 'techfleece'], alt: ['tech fleece', 'tech', '科技'] },
  { words: ['jordan', 'aj', 'jordans'], alt: ['jordan', 'aj', '乔丹'] },
  { words: ['dunk', 'dunks', 'sb dunk'], alt: ['dunk', 'dunksb'] },
  { words: ['air force 1', 'air force one', 'air force', 'af1', 'af'], alt: ['air force', 'af1', 'af 1', '空军'] },
  { words: ['air max', 'airmax'], alt: ['air max', 'airmax', '气垫'] },
  { words: ['adidas', 'addidas'], alt: ['adidas', '阿迪'] },
  { words: ['yeezy', 'yeezys'], alt: ['yeezy', 'yzy', '椰子', '侃爷'] },
  { words: ['new balance', 'nb'], alt: ['new balance', 'nb', '新百伦'] },
  { words: ['asics'], alt: ['asics', '亚瑟士', '亚瑟'] },
  { words: ['salomon'], alt: ['salomon', '萨洛蒙'] },
  { words: ['chrome hearts', 'ch'], alt: ['chrome hearts', 'chrome heart', 'ch', '克罗心'] },
  { words: ['balenciaga', 'balenci', 'bal'], alt: ['balenciaga', 'bal', '巴黎世家', '双b'] },
  { words: ['chanel'], alt: ['chanel', '小香', '香奈儿'] },
  { words: ['ralph lauren', 'ralph', 'rl', 'polo ralph'], alt: ['ralph lauren', 'ralph', 'rl', '小马', '拉夫劳伦'] },
  { words: ['burberry'], alt: ['burberry', '博柏利', '巴宝莉', '某b'] },
  { words: ['timberland', 'timbs', 'tbl'], alt: ['timberland', 'tbl', '踢不烂', '大黄靴'] },
  { words: ['bottega', 'bottega veneta', 'bv'], alt: ['bottega', 'bv', '葆蝶家'] },
  { words: ['gucci'], alt: ['gucci', '古驰'] },
  { words: ['prada'], alt: ['prada', '普拉达'] },
  { words: ['louis vuitton', 'lv', 'vuitton'], alt: ['louis vuitton', 'vuitton', 'lv', '路易威登'] },
  { words: ['dior'], alt: ['dior', '迪奥'] },
  { words: ['fendi'], alt: ['fendi', '芬迪'] },
  { words: ['saint laurent', 'ysl'], alt: ['saint laurent', 'ysl', '圣罗兰'] },
  { words: ['loewe'], alt: ['loewe', '罗意威'] },
  { words: ['moncler'], alt: ['moncler', '蒙口', '蒙克莱', '盟可睐'] },
  { words: ['canada goose'], alt: ['canada goose', '大鹅', '加拿大鹅'] },
  { words: ['arcteryx', "arc'teryx", 'arc teryx', 'arc'], alt: ['arcteryx', "arc'teryx", 'arc teryx', '始祖鸟'] },
  { words: ['north face', 'tnf'], alt: ['north face', 'tnf', '北面'] },
  { words: ['stussy'], alt: ['stussy', '斯图西'] },
  { words: ['stone island', 'stoney'], alt: ['stone island', '石头岛'] },
  { words: ['off white', 'off-white', 'offwhite', 'ow'], alt: ['off white', 'off-white', 'offwhite', 'ow'] },
  { words: ['margiela', 'mm6'], alt: ['margiela', 'mm6', '马吉拉'] },
  { words: ['lacoste'], alt: ['lacoste', '鳄鱼'] },
  { words: ['thom browne', 'tb'], alt: ['thom browne', '汤姆布朗'] },
  { words: ['cdg', 'comme des garcons'], alt: ['cdg', 'comme des garcons', '川久保玲'] },
  { words: ['carhartt'], alt: ['carhartt', '卡哈特'] },
  { words: ['essentials', 'fear of god', 'fog'], alt: ['essentials', 'fear of god', 'fog', '恐惧之神'] },
  { words: ['palm angels'], alt: ['palm angels', '棕榈天使'] },
  { words: ['hermes', 'hermès'], alt: ['hermes', 'hermès', '爱马仕'] },
  { words: ['cartier'], alt: ['cartier', '卡地亚'] },
  { words: ['van cleef', 'vca'], alt: ['van cleef', 'vca', '梵克雅宝', '四叶草'] },
  { words: ['rolex'], alt: ['rolex', '劳力士'] },
  { words: ['bape'], alt: ['bape', '猿人头'] },
  { words: ['ny', 'yankees', 'new york', 'mlb'], alt: ['ny', 'yankees', 'new york', 'mlb', '洋基'] },
  { words: ['diesel'], alt: ['diesel', '迪赛'] },
  { words: ['miu miu', 'miumiu'], alt: ['miu miu', 'miumiu', '缪缪'] },
  { words: ['celine'], alt: ['celine', '赛琳', '思琳'] },
  { words: ['valentino'], alt: ['valentino', '华伦天奴'] },
  { words: ['versace'], alt: ['versace', '范思哲'] },
  { words: ['givenchy'], alt: ['givenchy', '纪梵希'] },
  { words: ['vivienne westwood', 'westwood', 'vivienne'], alt: ['vivienne westwood', 'westwood', '西太后'] },
  { words: ['goyard'], alt: ['goyard', '戈雅'] },
  { words: ['ugg', 'uggs'], alt: ['ugg', '雪地靴'] },
  { words: ['converse'], alt: ['converse', '匡威'] },
  { words: ['vans'], alt: ['vans', '万斯'] },
  { words: ['puma'], alt: ['puma', '彪马'] },
  { words: ['onitsuka', 'onitsuka tiger'], alt: ['onitsuka', '鬼冢虎'] },
  { words: ['hellstar'], alt: ['hellstar'] },
  { words: ['sp5der', 'spider'], alt: ['sp5der', 'spider'] },
  { words: ['broken planet'], alt: ['broken planet'] },
  { words: ['syna', 'synaworld'], alt: ['syna', 'synaworld'] },
  { words: ['nocta'], alt: ['nocta'] },
  { words: ['represent'], alt: ['represent'] },
  { words: ['ami', 'ami paris'], alt: ['ami paris', 'ami'] },
  { words: ['acne', 'acne studios'], alt: ['acne studios', 'acne'] },
  { words: ['boss', 'hugo boss'], alt: ['hugo boss', 'boss', '博斯'] },
  { words: ['tommy', 'tommy hilfiger'], alt: ['tommy hilfiger', 'tommy', '汤米'] },
  { words: ['calvin klein', 'ck'], alt: ['calvin klein', 'ck', '卡尔文克莱恩'] },
  { words: ['levis', "levi's", 'levi'], alt: ["levi's", 'levis', '李维斯'] },
  { words: ['dickies'], alt: ['dickies', '迪克斯'] },
  { words: ['patagonia'], alt: ['patagonia', '巴塔哥尼亚'] },
  { words: ['oakley'], alt: ['oakley', '欧克利'] },
  { words: ['ray-ban', 'rayban', 'ray ban'], alt: ['ray-ban', 'rayban', '雷朋'] },
  { words: ['palace'], alt: ['palace'] },
  { words: ['kith'], alt: ['kith'] },
  { words: ['rhude'], alt: ['rhude'] },
  { words: ['cp company', 'c.p. company'], alt: ['cp company', 'c.p. company'] },
  { words: ['barbour'], alt: ['barbour', '巴伯尔'] },
  { words: ['loro piana'], alt: ['loro piana', '诺悠翩雅'] },
  { words: ['vetements'], alt: ['vetements'] },
  { words: ['crocs'], alt: ['crocs', '卡骆驰'] },
  { words: ['polene'], alt: ['polene', 'polène'] },
  { words: ['trapstar'], alt: ['trapstar'] },
  { words: ['corteiz', 'crtz'], alt: ['corteiz', 'crtz'] },
  { words: ['denim tears'], alt: ['denim tears'] },
  { words: ['gallery dept'], alt: ['gallery dept'] },
  { words: ['amiri'], alt: ['amiri'] },
  { words: ['rick owens', 'rick'], alt: ['rick owens', 'ro'] },
];

// Couleurs (français et anglais → mots des vendeurs).
const COLORS = [
  { words: ['black', 'noir', 'noire'], alt: ['black', '黑'] },
  { words: ['white', 'blanc', 'blanche'], alt: ['white', '白'] },
  { words: ['grey', 'gray', 'gris', 'grise'], alt: ['grey', 'gray', '灰'] },
  { words: ['blue', 'bleu', 'bleue', 'navy'], alt: ['blue', 'navy', '蓝'] },
  { words: ['red', 'rouge'], alt: ['red', '红'] },
  { words: ['green', 'vert', 'verte'], alt: ['green', '绿'] },
  { words: ['brown', 'marron'], alt: ['brown', '棕', '咖啡色'] },
  { words: ['beige', 'cream', 'creme', 'crème'], alt: ['beige', 'cream', '米白', '米色', '杏色'] },
  { words: ['pink', 'rose'], alt: ['pink', '粉'] },
  { words: ['yellow', 'jaune'], alt: ['yellow', '黄'] },
  { words: ['purple', 'violet'], alt: ['purple', '紫'] },
  { words: ['orange'], alt: ['orange', '橙'] },
];

// Modèles, logos et noms codés des vendeurs qui désignent une marque sans la nommer (« Tech Fleece », « Swoosh »,
// « N家 » = la marque N, « 驴牌 » = LV) : une recherche de la marque les trouve aussi. Pour la recherche seulement
// (pas pour le glossaire de traduction : certains codes sont trop vagues pour réécrire un titre).
const LINES = {
  nike: ['swoosh', 'tech fleece', 'techfleece', 'dunk', 'air force', 'af1', 'air max', 'airmax', 'vapormax', 'cortez', 'blazer',
    'windrunner', 'acg', 'nocta', 'air jordan', 'aj1', 'aj4', 'aj11', 'shox', 'p-6000', 'N家', '勾子', '钩子', '空军一号', '科技羊毛'],
  jordan: ['air jordan', 'aj1', 'aj3', 'aj4', 'aj11', 'jumpman', '飞人'],
  adidas: ['samba', 'gazelle', 'adidas campus', 'spezial', 'superstar', 'stan smith', 'three stripes', '3 stripes', 'trefoil',
    'ultraboost', 'handball spezial', '三叶草', '三道杠'],
  yeezy: ['foam runner', 'boost 350', 'yeezy slide'],
  'new balance': ['9060', '2002r', '1906r', '530', '550'],
  'louis vuitton': ['damier', 'speedy', 'neverfull', 'keepall', 'pochette metis', 'L家', '驴牌'], // pas « monogram » / « 老花 » : Coach aussi
  gucci: ['gg marmont', 'marmont', 'dionysus', 'horsebit', 'ophidia', 'G家', '双G'],
  chanel: ['classic flap', 'boy bag', '2.55', 'C家', '小香风'],
  dior: ['oblique', 'saddle bag', 'lady dior', 'b23', 'b22', 'b30', 'D家'],
  hermes: ['birkin', 'kelly', 'constance', 'evelyne', 'oran', 'picotin', 'H家', '铂金包'],
  balenciaga: ['triple s', 'speed trainer', 'cagole', '3xl', '10xl'],
  prada: ['re-nylon', 'cloudbust', 'americas cup', 'P家'],
  moncler: ['maya', 'montbeliard', 'M家'],
  'canada goose': ['expedition parka', 'chilliwack', 'wyndham', 'langford'],
  arcteryx: ['beta lt', 'beta ar', 'alpha sv', 'atom lt', 'atom hoody', '鸟家'],
  'stone island': ['compass badge', 'ghost piece', 'shadow project', '石头'],
  supreme: ['box logo', 'bogo'],
  'ralph lauren': ['polo bear', 'big pony'],
  bape: ['shark hoodie', 'ape head', 'a bathing ape', 'baby milo', '猿人', '鲨鱼'],
  'off white': ['industrial belt'],
  corteiz: ['alcatraz', 'rules the world'],
  trapstar: ['its a secret', 'irongate'],
  'denim tears': ['cotton wreath'],
};

const DICT = [
  // base : les noms de la marque seuls (pour les formes collées « jordan 4 » → « jordan4 », pas « aj14 »).
  ...BRANDS.map((d) => ({ ...d, base: d.alt, alt: [...d.alt, ...(LINES[d.words[0]] || []).map((a) => a.toLowerCase())], kind: 'brand' })),
  ...TYPES.map((d) => ({ ...d, kind: 'type' })),
  ...COLORS.map((d) => ({ ...d, kind: 'color' })),
];
const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'en', 'pour', 'the', 'a', 'an', 'of', 'for', 'and', 'with', 'avec']);

// Minuscules, sans accents (« survêtement » = « survetement »), chinois intact.
const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
const normalize = (q) => deaccent(String(q || '').toLowerCase().normalize('NFKC'))
  .replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();

const WORDS = new Map();
for (const d of DICT) for (const w of d.words) if (!WORDS.has(deaccent(w))) WORDS.set(deaccent(w), d);

// Distance d'édition (fautes de frappe : « suprem », « moncker », « jordna »).
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Damerau (OSA) : deux lettres inversées comptent pour une seule faute.
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Mot du dictionnaire : exact, au singulier, ou à une faute près (deux pour les mots longs).
function lookup(word) {
  if (WORDS.has(word)) return WORDS.get(word);
  const single = word.replace(/(es|s|x)$/, '');
  if (single !== word && single.length >= 3 && WORDS.has(single)) return WORDS.get(single);
  if (word.length < 4 || /\d/.test(word) || !/^[a-z' -]+$/.test(word)) return null;
  const phrase = word.includes(' ');
  const max = word.length >= 7 ? 2 : 1;
  let best = null;
  let bestD = max + 1;
  for (const [w, d] of WORDS) {
    if (w.length < 4 || w.includes(' ') !== phrase || w[0] !== word[0]) continue;
    const dd = distance(word, w, max);
    if (dd < bestD) { best = d; bestD = dd; }
  }
  return best;
}

// « aj4 » → « aj 4 », « nb550 » → « nb 550 » (sauf si le mot collé est connu tel quel, comme « af1 » ou « mm6 »).
function tokens(q) {
  const out = [];
  for (const w of normalize(q).split(' ').filter(Boolean)) {
    const m = w.match(/^([a-z]+)(\d{1,4})$/);
    if (m && !WORDS.has(w) && lookup(m[1])) out.push(m[1], m[2]);
    else out.push(w);
  }
  return out.slice(0, 10);
}

// Groupes d'une recherche : [{ alt: [équivalents], cat, kind }]. Les expressions de trois puis deux mots passent
// avant les mots seuls. Un numéro de modèle après une marque accepte aussi la forme collée (« jordan 4 » → aj4).
// Noms chinois des marques → nom anglais (« 迪赛 » → « Diesel »), pour le glossaire de la traduction des titres.
// Les mots trop vagues (科技 = technologie, 气垫 = coussin d'air, 四叶草 = trèfle) sont exclus.
const VAGUE = new Set(['科技', '气垫', '四叶草', '巴黎', '鳄鱼']);
const title = (s) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bOf\b/g, 'of');
export function chineseBrandNames() {
  const out = [];
  for (const b of BRANDS) {
    const name = b.alt.find((a) => /^[a-z0-9 '&-]+$/.test(a) && a.length > 2);
    if (!name) continue;
    for (const zh of b.alt) if (/[\u4e00-\u9fff]/.test(zh) && !VAGUE.has(zh)) out.push([zh, title(name)]);
  }
  return out;
}

export function expandQuery(q) {
  const words = tokens(q);
  const groups = [];
  for (let i = 0; i < words.length; i++) {
    let entry = null;
    for (const n of [3, 2]) {
      const phrase = words.slice(i, i + n).join(' ');
      const found = i + n <= words.length && (WORDS.get(phrase) || lookup(phrase));
      if (found) { entry = found; i += n - 1; break; }
    }
    if (!entry && !STOP.has(words[i])) entry = lookup(words[i]);
    if (entry) groups.push({ alt: entry.alt, base: entry.base, cat: entry.cat || null, kind: entry.kind });
    else if (!STOP.has(words[i])) groups.push({ alt: [words[i]], cat: null, kind: /^\d+$/.test(words[i]) ? 'num' : 'word' });
  }
  for (let i = 1; i < groups.length; i++) {
    const brand = groups[i - 1];
    const num = groups[i];
    if (brand.kind !== 'brand' || num.kind !== 'num') continue;
    const glued = (brand.base || brand.alt).filter((a) => !a.includes(' ')).map((a) => `${a}${num.alt[0]}`);
    groups[i - 1] = { ...brand, alt: [...brand.alt, ...glued] };
    groups[i] = { ...num, alt: [...num.alt, ...glued] };
  }
  return groups;
}

// Recherche sans résultat : on retire d'abord une couleur, puis un type d'article, puis un mot inconnu.
const DROP_ORDER = ['color', 'type', 'word', 'num'];
export function relaxQuery(groups) {
  if (!groups || groups.length < 2) return null;
  for (const kind of DROP_ORDER) {
    const i = groups.map((g) => g.kind).lastIndexOf(kind);
    if (i >= 0) return groups.filter((_, j) => j !== i);
  }
  return null;
}

// Une seule chaîne : est-ce qu'un équivalent est présent (mot entier pour les mots latins) ?
const latin = (s) => /^[\p{Script=Latin}\d' -]+$/u.test(s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function groupRegex(group) {
  const parts = group.alt.map((a) => (latin(a)
    ? `(?<![\\p{L}\\p{N}])${escapeRe(a).replace(/[ -]/g, '[\\s-]?')}s?(?![\\p{L}\\p{N}])`
    : escapeRe(a)));
  return new RegExp(parts.join('|'), 'iu');
}

// Pertinence d'un item pour une recherche : 0 = ne correspond pas. Plus le titre anglais (le plus propre) contient
// de mots cherchés, plus l'item remonte ; un item déjà classé dans le bon type compte aussi.
export function relevance(groups, item) {
  // brand : marque lue sur la photo de l'item (index de recherche), quand le titre ne la donne pas.
  const text = `${item.title_en || ''} ${item.title_zh || ''} ${item.shop_name || ''} ${item.brand || ''}`;
  let score = 0;
  for (const g of groups) {
    const re = groupRegex(g);
    const inText = re.test(text);
    const inCat = g.cat && item.category === g.cat;
    if (!inText && !inCat) return 0;
    score += (item.title_en && re.test(item.title_en) ? 2 : 1) + (inText && inCat ? 1 : 0);
    // Le vrai nom de la marque (pas seulement un modèle ou un nom codé) : l'item passe devant.
    if (g.base && g.base !== g.alt && groupRegex({ alt: g.base }).test(text)) score += 1;
  }
  return score;
}

// Suggestions pendant la frappe de /find (autocomplétion Discord) : marques, puis marque + type d'article.
// Calculé ici, sans base de données. 25 suggestions au plus (limite Discord).
const POPULAR_TYPES = ['hoodie', 'tee', 'jacket', 'pants', 'shorts', 'shoes', 'bag', 'cap', 'sweater', 'puffer', 'tracksuit', 'jeans'];
const POPULAR_MODELS = ['nike tech fleece', 'jordan 4', 'jordan 1', 'dunk low', 'air force 1', 'yeezy 350', 'new balance 550',
  'supreme box logo', 'chrome hearts hoodie', 'stone island sweatshirt', 'moncler puffer', 'canada goose', 'essentials hoodie',
  'ralph lauren polo', 'trapstar tracksuit', 'corteiz cargos', 'bape hoodie', 'arcteryx jacket', 'denim tears', 'gallery dept'];
export function suggestQueries(input) {
  const q = normalize(input);
  const names = BRANDS.map((b) => b.alt.find((a) => /^[a-z0-9 '&-]+$/.test(a) && a.length > 2)).filter(Boolean);
  if (!q) return POPULAR_MODELS.slice(0, 25);
  const out = [];
  const add = (x) => { if (x && !out.includes(x) && out.length < 25) out.push(x); };
  for (const m of POPULAR_MODELS) if (m.startsWith(q)) add(m);
  // Surnom ou faute de frappe d'une marque (« lv », « ch », « suprem ») : son nom complet.
  const known = lookup(q.split(' ')[0]);
  if (known && known.kind === 'brand') {
    const full = known.alt.find((a) => /^[a-z0-9 '&-]+$/.test(a) && a.length > 2);
    if (full) { add(full); for (const t of POPULAR_TYPES.slice(0, 4)) add(`${full} ${t}`); }
  }
  // « nike h » : marque complète + début d'un type d'article.
  for (const n of names) {
    if (q.startsWith(`${n} `)) {
      const rest = q.slice(n.length + 1);
      for (const t of POPULAR_TYPES) if (t.startsWith(rest)) add(`${n} ${t}`);
    }
  }
  for (const n of names) if (n.startsWith(q)) add(n);
  for (const n of names) if (n.startsWith(q)) for (const t of POPULAR_TYPES.slice(0, 4)) add(`${n} ${t}`);
  for (const m of POPULAR_MODELS) if (m.includes(q)) add(m);
  add(q); // toujours ce qui a été tapé
  return out.slice(0, 25);
}

// Le texte cite-t-il une marque connue (nom, modèle ou nom codé) ? Pour choisir les items dont la marque est à lire
// sur la photo.
let anyBrand = null;
export function mentionsBrand(text) {
  anyBrand = anyBrand || DICT.filter((d) => d.kind === 'brand').map((d) => groupRegex(d));
  return anyBrand.some((re) => re.test(String(text || '')));
}

// Noms d'une marque cherchée (sans ses modèles), en minuscules : pour la comparer à la marque lue sur une photo.
export const brandNames = (group) => (group.base || []).filter((a) => /^[a-z0-9 '&.-]+$/.test(a)).map((a) => a.toLowerCase());
