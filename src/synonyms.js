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
  { words: ['bag', 'bags', 'sac', 'sacs', 'backpack', 'tote', 'handbag'], alt: ['bag', 'backpack', 'tote', '包'], cat: 'bags' },
  { words: ['wallet', 'wallets', 'portefeuille', 'cardholder'], alt: ['wallet', 'card holder', '钱包', '卡包'], cat: 'accessories' },
  { words: ['cap', 'caps', 'casquette', 'casquettes', 'hat', 'hats', 'chapeau'], alt: ['cap', 'hat', '帽'], cat: 'accessories' },
  { words: ['beanie', 'bonnet'], alt: ['beanie', '毛线帽', '针织帽'], cat: 'accessories' },
  { words: ['belt', 'belts', 'ceinture'], alt: ['belt', '腰带', '皮带'], cat: 'accessories' },
  { words: ['sunglasses', 'lunettes', 'glasses'], alt: ['sunglasses', 'glasses', '墨镜', '眼镜'], cat: 'accessories' },
  { words: ['scarf', 'echarpe', 'écharpe'], alt: ['scarf', '围巾'], cat: 'accessories' },
  { words: ['socks', 'chaussettes'], alt: ['socks', '袜'], cat: 'accessories' },
  { words: ['necklace', 'collier', 'chain', 'chaine', 'chaîne'], alt: ['necklace', 'chain', '项链'], cat: 'jewelry' },
  { words: ['bracelet', 'bracelets'], alt: ['bracelet', '手镯', '手链'], cat: 'jewelry' },
  { words: ['ring', 'rings', 'bague', 'bagues'], alt: ['ring', '戒指'], cat: 'jewelry' },
  { words: ['earrings', 'boucles'], alt: ['earring', '耳环', '耳钉'], cat: 'jewelry' },
  { words: ['watch', 'watches', 'montre', 'montres'], alt: ['watch', '手表'], cat: 'jewelry' },
];

// Marques : nom, surnoms et noms chinois des vendeurs (le même glossaire que la traduction des titres).
const BRANDS = [
  { words: ['supreme', 'sup'], alt: ['supreme', 'sup'] },
  { words: ['nike', 'nk'], alt: ['nike', 'nk', '耐克'] },
  { words: ['tech', 'techfleece'], alt: ['tech fleece', 'tech', '科技'] },
  { words: ['jordan', 'aj', 'jordans'], alt: ['jordan', 'aj', '乔丹'] },
  { words: ['dunk', 'dunks'], alt: ['dunk', 'sb'] },
  { words: ['adidas', 'addidas'], alt: ['adidas', '阿迪'] },
  { words: ['yeezy', 'yeezys'], alt: ['yeezy', 'yzy', '椰子', '侃爷'] },
  { words: ['new balance', 'nb'], alt: ['new balance', 'nb', '新百伦'] },
  { words: ['asics'], alt: ['asics', '亚瑟士', '亚瑟'] },
  { words: ['salomon'], alt: ['salomon', '萨洛蒙'] },
  { words: ['chrome hearts', 'ch'], alt: ['chrome hearts', 'chrome heart', 'ch', '克罗心'] },
  { words: ['balenciaga', 'balenci', 'bal'], alt: ['balenciaga', 'bal', '巴黎世家', '巴黎', '双b'] },
  { words: ['chanel'], alt: ['chanel', '小香', '香奈儿'] },
  { words: ['ralph lauren', 'ralph', 'rl', 'polo ralph'], alt: ['ralph lauren', 'ralph', 'rl', '小马', '拉夫劳伦'] },
  { words: ['burberry'], alt: ['burberry', '博柏利', '巴宝莉', '某b'] },
  { words: ['timberland', 'timbs', 'tbl'], alt: ['timberland', 'tbl', '踢不烂', '大黄靴'] },
  { words: ['bottega', 'bottega veneta', 'bv'], alt: ['bottega', 'bv', '葆蝶家'] },
  { words: ['gucci'], alt: ['gucci', '古驰'] },
  { words: ['prada'], alt: ['prada', '普拉达'] },
  { words: ['louis vuitton', 'lv', 'vuitton'], alt: ['louis vuitton', 'vuitton', 'lv', '路易威登', '老花'] },
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
  { words: ['brown', 'marron'], alt: ['brown', '棕', '咖'] },
  { words: ['beige', 'cream', 'creme', 'crème'], alt: ['beige', 'cream', '米'] },
  { words: ['pink', 'rose'], alt: ['pink', '粉'] },
  { words: ['yellow', 'jaune'], alt: ['yellow', '黄'] },
  { words: ['purple', 'violet'], alt: ['purple', '紫'] },
  { words: ['orange'], alt: ['orange', '橙'] },
];

const DICT = [...BRANDS, ...TYPES, ...COLORS];
const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'en', 'pour', 'the', 'a', 'an', 'of', 'for', 'and', 'with', 'avec']);

const normalize = (q) => String(q || '').toLowerCase().normalize('NFKC')
  .replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();

// Groupes d'une recherche : [{ alt: [équivalents], cat }]. Les expressions de deux mots passent avant les mots seuls.
export function expandQuery(q) {
  const words = normalize(q).split(' ').filter(Boolean).slice(0, 8);
  const groups = [];
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : null;
    const entry = (pair && DICT.find((d) => d.words.includes(pair))) || DICT.find((d) => d.words.includes(words[i]));
    if (entry && pair && entry.words.includes(pair)) i++;
    if (entry) groups.push({ alt: entry.alt, cat: entry.cat || null });
    else if (!STOP.has(words[i])) groups.push({ alt: [words[i]], cat: null });
  }
  return groups;
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
  const text = `${item.title_en || ''} ${item.title_zh || ''} ${item.shop_name || ''}`;
  let score = 0;
  for (const g of groups) {
    const re = groupRegex(g);
    const inText = re.test(text);
    const inCat = g.cat && item.category === g.cat;
    if (!inText && !inCat) return 0;
    score += (item.title_en && re.test(item.title_en) ? 2 : 1) + (inText && inCat ? 1 : 0);
  }
  return score;
}
