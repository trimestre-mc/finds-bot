// Points de contrôle d'expert par marque (ce qu'un revendeur vérifie en premier sur les QC d'un rep). Ajoutés aux
// consignes de l'analyse IA (vision.js) dès que l'article est identifié.

const GUIDE = [
  [/bape|a bathing ape/i, 'BAPE : camo = têtes de singe nettes et bien dessinées (pas de taches floues), couleurs franches ; lettres « BAPE » / « A BATHING APE » dans la bonne police (lettres régulières, pas déformées) ; shark hoodie : visage de requin aligné, « WGM » brodé, zip jusqu\'en haut de la capuche ; tissu en coton épais mat (pas de polyester brillant) ; zip de marque (YKK).'],
  [/supreme/i, 'Supreme : plusieurs logos officiels existent, tous normaux : box logo (police Futura Heavy Oblique, rouge vif, lettres bien espacées, bords nets, broderie dense) OU « Supreme » en écriture gothique Old English, souvent brodé ton sur ton ou en relief (lettres fines, régulières, lisibles) OU petit texte script. Ne pénalise pas l\'absence de box logo. Étiquette de col rouge « Supreme » si visible ; coton épais.'],
  [/chrome hearts|\bch\b/i, 'Chrome Hearts : croix et dagues bien proportionnées, impression nette (pas pixelisée), texte en sanskrit / « Made in Hollywood » lisible ; quincaillerie (boutons, rivets) en argent massif gravé ; étiquettes de lavage complètes.'],
  [/stone island/i, 'Stone Island : badge boussole sur le bras gauche, bord brodé régulier, deux boutons noirs ; étiquette « Code » intérieure avec QR et numéro de série ; tissu et couleur conformes.'],
  [/jordan|air jordan/i, 'Air Jordan : forme du bout et du talon, hauteur du col, logo Jumpman bien proportionné (doigts, pieds), étiquette intérieure (pointures cohérentes, code produit, dates), coutures régulières sur le toe box, pas de traces de colle à la jonction semelle-tige ; Jordan 4 : filet, ailettes, languette.'],
  [/nike|tech fleece|dunk|air force|af1/i, 'Nike : swoosh à la bonne forme (pointe fine, courbe régulière) et bien placé ; Tech Fleece : coutures thermocollées nettes, fermetures éclair de marque, logo caoutchouc régulier ; Dunk / AF1 : forme du toe box, swoosh, étiquette intérieure (code, pointures cohérentes), pas de colle.'],
  [/essentials|fear of god/i, 'Fear of God Essentials : logo « ESSENTIALS » en caoutchouc/relief aux lettres régulières et bien espacées, coton épais, coupe ample, étiquettes intérieures avec la bonne police.'],
  [/moncler/i, 'Moncler : badge en feutre (coq, cloche) aux couleurs nettes, coutures du matelassage régulières, gonflant homogène, fermetures Lampo/Riri, étiquettes avec QR et certilogo.'],
  [/canada goose/i, 'Canada Goose : patch rond « Arctic Program » aux couleurs et broderie nettes, fourrure (si présente) dense, étiquettes intérieures complètes, coutures régulières.'],
  [/louis vuitton|\blv\b/i, 'Louis Vuitton : monogramme aligné et symétrique (pas coupé au mauvais endroit), couleurs du canevas, coutures régulières jaune moutarde, quincaillerie gravée nette, date code / puce.'],
  [/gucci/i, 'Gucci : motif GG aligné, bande verte-rouge-verte aux bonnes couleurs, gravures nettes, étiquettes en cuir avec le bon texte.'],
  [/dior/i, 'Dior : motif Oblique régulier et aligné, broderies nettes, quincaillerie gravée, étiquettes.'],
  [/balenciaga/i, 'Balenciaga : logo à la bonne police et usure (« distressed ») régulière, coupe oversize, semelles et coutures (Triple S, Track).'],
  [/ralph lauren|polo/i, 'Ralph Lauren : petit cheval brodé bien dessiné (joueur, maillet, pattes), couleur de la broderie, étiquette de col.'],
  [/trapstar/i, 'Trapstar : logo et texte (« IT\'S A SECRET ») en relief ou brodés nets, police correcte, tissu épais.'],
  [/corteiz|crtz/i, 'Corteiz : logo Alcatraz bien dessiné et centré, police correcte, broderie ou impression nette.'],
  [/gallery dept/i, 'Gallery Dept : texte « GALLERY DEPT. » à la bonne police, taches de peinture irrégulières mais nettes, coton épais délavé.'],
  [/arc'?teryx/i, 'Arc\'teryx : logo oiseau fossile brodé net, fermetures étanches de marque, coutures thermocollées, étiquettes Gore-Tex si concernées.'],
  [/north face|tnf/i, 'The North Face : logo demi-dôme brodé net et bien placé, coutures du matelassage, fermetures de marque.'],
  [/off.?white/i, 'Off-White : rayures diagonales régulières et alignées, flèches nettes, texte entre guillemets à la bonne police, étiquette zip-tie.'],
];

// Savoir général d'un contrôleur QC, par type d'article (vaut pour toutes les marques, même inconnues).
const TYPES = [
  [/sneaker|basket|chaussure|shoe|jordan|dunk|air force|af1|yeezy|new balance|\bnb\b|trainer|runner|triple s/i, 'Chaussures : compare les deux pieds (même forme, même hauteur, logos à la même place) ; bout (toe box) ni trop pointu ni gonflé ; talon droit vu de dos, pas penché ; colle qui déborde à la jonction semelle-tige ; coutures doublées régulières, pas de fils ; cuir sans plis profonds ni craquelures ; semelle propre, motif net ; étiquette intérieure : code produit et pointures cohérentes entre elles et entre les deux pieds ; lacets et boîte secondaires.'],
  [/boot|botte|slide|claquette|sandal|mule|clog|loafer|mocassin/i, 'Bottes, claquettes, mocassins : symétrie des deux pieds, semelle bien collée sans débord, coutures, logo en relief net, matière (daim régulier, cuir sans plis), boucles et quincaillerie gravées.'],
  [/hoodie|sweat|crewneck|pull|zip.?up|fleece/i, 'Sweat / hoodie : épaisseur du molleton (un bon sweat tient sa forme, pas fin ni transparent) ; côtes des poignets et du bas épaisses et serrées ; capuche doublée si le vrai l\'est ; cordons et œillets métal, embouts propres ; zip de marque qui ferme droit ; logo : broderie dense sans trous ni fils sautés, ou impression sérigraphie opaque (pas un transfert plastique brillant qui craquelle) ; logo centré à la bonne hauteur.'],
  [/\bt.?shirt|\btee\b|polo|débardeur|tank/i, 'T-shirt / polo : épaisseur et tenue du coton (heavyweight si le vrai l\'est), col côtelé qui ne gondole pas, coutures double aiguille régulières aux manches et au bas ; impression : sérigraphie opaque et nette, pas pixelisée, pas de transfert brillant ; placement et taille du logo ; étiquette de col.'],
  [/jacket|veste|puffer|doudoune|coat|manteau|parka|windbreaker|coupe.?vent|gilet|vest/i, 'Veste / doudoune : matelassage régulier, gonflant homogène sans zones plates, plumes qui ne sortent pas ; zip de marque qui glisse droit, rabats alignés ; boutons-pression gravés ; doublure bien cousue ; coutures droites des épaules et des manches ; patch ou badge net ; capuche et fourrure symétriques.'],
  [/jean|denim/i, 'Jean : délavage et usure naturels (pas un motif répété ou imprimé), toile épaisse, coutures en fil épais régulières (surpiqûres, poches arrière symétriques), rivets et bouton gravés, patch en cuir au dos, ourlet, étiquettes.'],
  [/pant|pantalon|jogger|jogging|short|cargo|trouser|sweatpant|tracksuit|survêt/i, 'Pantalon / short / jogging : cordon et œillets, élastique de taille régulier, poches symétriques et bien cousues, coutures latérales droites, logo net à la bonne place, bas et chevilles, étiquettes.'],
  [/knit|maille|cardigan|sweater|beanie|bonnet/i, 'Maille : mailles régulières sans trous ni fils tirés, motif tricoté (pas imprimé) si le vrai l\'est, côtes bien serrées, logo tissé ou brodé net, épaisseur.'],
  [/\bshirt\b|chemise|overshirt/i, 'Chemise : col symétrique et rigide, boutons alignés et bien cousus, boutonnières propres, motif aligné aux coutures, poignets, étiquettes.'],
  [/\bcap\b|casquette|\bhat\b|chapeau|bucket/i, 'Casquette / chapeau : forme de la visière et de la couronne (symétrique, pas écrasée), broderie 3D dense sans fils sautés, œillets brodés, bande intérieure et étiquettes, fermeture arrière (boucle gravée).'],
  [/bag|sac|tote|backpack|pochette|pouch|purse|handbag|sacoche|crossbody/i, 'Sac : symétrie et tenue de la forme (pas mou ni affaissé), coutures régulières au même nombre de points, bords peints (tranches) lisses sans bavure, motif aligné et continu aux coutures, quincaillerie lourde et gravée net (pas de peinture qui s\'écaille), zip de marque, doublure, numéro de série / étiquette intérieure.'],
  [/wallet|portefeuille|card ?holder|porte.?carte|belt|ceinture/i, 'Portefeuille / ceinture : coutures régulières, tranches peintes lisses, cuir sans plis ni aspect plastique, boucle lourde gravée nette, estampage du logo net et droit.'],
  [/watch|montre|rolex|\bap\b|audemars|omega|cartier/i, 'Montre : alignement des index et de la lunette, marquages du cadran nets et bien espacés, aiguilles qui atteignent les index, date centrée dans sa fenêtre (loupe), couronne, finitions brossées / polies franches, bracelet et fermoir gravés.'],
  [/\bring\b|bague|necklace|collier|chain|chaîne|bracelet|earring|boucle d.oreille|pendant|pendentif|jewel|bijou/i, 'Bijou : poids et épaisseur, gravures et poinçons nets, poli régulier sans rayures ni bulles, pierres serties droites, fermoir solide, couleur du métal homogène (pas de plaquage qui part).'],
  [/sunglass|lunette|glasses/i, 'Lunettes : symétrie de la monture, charnières métal, gravures sur les branches, logo net, verres sans défaut, étui.'],
];

// Ce qui trahit un mauvais batch quel que soit l'article.
const GENERAL = 'Savoir général d\'un contrôleur : '
  + 'une marque a souvent plusieurs logos officiels (box, script, gothique, petit logo, ton sur ton) : ne pénalise pas un logo parce que ce n\'est pas la version la plus connue, juge la qualité de son exécution. '
  + 'Matière : le coton épais est mat avec un grain visible, le polyester bon marché brille et paraît fin ; le cuir bon marché a un aspect plastique, lisse et uniforme. '
  + 'Impression : sérigraphie = encre opaque, bords nets ; transfert / DTF bon marché = film brillant plastique, bords visibles ; sublimation = couleurs fondues dans le tissu, souvent sur polyester. Broderie : dense, points serrés, pas de fond visible entre les points. '
  + 'Coutures : régulières, droites, même espacement, pas de fils qui dépassent ni de points sautés. Quincaillerie (zips, boutons, rivets) : de marque, gravée nette, pas de peinture qui s\'écaille. '
  + 'Couleur : compare à la photo du vendeur, mais une photo d\'entrepôt (lumière jaune ou blanche) change un peu la teinte. '
  + 'Mesures : une différence de plus de 2-3 cm avec le guide des tailles compte. '
  + 'Taches, plis de transport et odeur ne sont pas des défauts du batch (lavables), sauf tache de colle ou d\'encre.';

// Points d'expert pour un article (marque + type) : ce qu'un revendeur regarde en premier, puis le savoir général.
export function qcGuide(article) {
  const text = String(article || '');
  const brands = GUIDE.filter(([re]) => re.test(text)).map(([, tip]) => tip).slice(0, 2);
  const types = TYPES.filter(([re]) => re.test(text)).map(([, tip]) => tip).slice(0, 2);
  return [
    brands.length ? `Points d'expert pour cette marque : ${brands.join(' ')}` : '',
    types.length ? `Points d'expert pour ce type d'article : ${types.join(' ')}` : '',
    GENERAL,
  ].filter(Boolean).join('\n');
}

// Type d'article reconnu dans le texte ? (sinon l'analyse garde la liste courte de tous les types)
export const knownType = (article) => TYPES.some(([re]) => re.test(String(article || '')));

// Ce qu'un contrôleur sévère vérifie, par type d'article, et ce qui est NORMAL pour ce type (à ne pas prendre pour
// un défaut). Le premier type reconnu dans le nom de l'article l'emporte.
const CHECKS = [
  [/sneaker|basket|chaussure|shoe|jordan|dunk|air force|af1|yeezy|new balance|\bnb\b|trainer|runner|triple s|\bb2[0-9]\b|\bb30\b|samba|gazelle/i,
    'CHAUSSURES', 'forme du bout (toe box) trop gonflé ou trop pointu, talon penché vu de dos, hauteur du col, silhouette du vrai modèle ; symétrie entre les deux chaussures ; colle qui déborde à la jonction semelle-tige, semelle mal alignée ou tachée ; coutures de travers ou fils ; logo (marque, swoosh, CD, Jumpman…) déformé, mal placé ou de mauvaise taille ; cuir craquelé ou plastique, daim irrégulier, plis profonds',
    'mesh, nylon, synthétique, cuir lisse ou verni selon le modèle ; ne parle ni de polyester ni de densité de coutures comme pour un vêtement'],
  [/boot|botte|slide|claquette|sandal|mule|clog|loafer|mocassin/i,
    'BOTTES, CLAQUETTES, MOCASSINS', 'symétrie des deux pieds, semelle collée sans débord, coutures, logo en relief net et bien placé, boucles et quincaillerie gravées, matière (daim régulier, cuir sans plis profonds)',
    'caoutchouc, EVA ou mousse pour les claquettes ; synthétique selon le modèle'],
  [/jersey|maillot|football|soccer|\bkit\b|basketball shirt|nba/i,
    'MAILLOT DE SPORT', 'écusson du club (brodé ou thermocollé selon la version) net et bien centré, sponsors et logo de l\'équipementier nets et bien placés, flocage (nom, numéro) régulier sans bulles, couleurs et motifs du vrai maillot, coutures, étiquette intérieure (code produit, taille)',
    'tissu technique en polyester léger et un peu brillant ; la version « player » est plus fine et ajustée, la version « fan » plus épaisse avec un écusson brodé'],
  [/hoodie|sweat|crewneck|pull(over)?\b|zip.?up|fleece|tech fleece/i,
    'SWEAT, HOODIE', 'épaisseur du molleton (tient sa forme, pas fin ni transparent) ; logo : broderie dense sans fils sautés ou impression opaque et nette (pas pixelisée, pas de film plastique qui craquelle) ; police et proportions du logo ; côtes des poignets et du bas serrées ; cordons, œillets et zip de marque ; coutures droites',
    'Tech Fleece et sweats techniques sont en coton-polyester, un aspect lisse est normal ; coton épais et mat pour la plupart des marques streetwear'],
  [/puffer|doudoune|down jacket|parka|coat|manteau|windbreaker|coupe.?vent|jacket|veste|gilet|vest/i,
    'VESTE, DOUDOUNE', 'matelassage régulier, gonflant homogène sans zones plates, plumes qui ne sortent pas ; zip de marque qui ferme droit ; boutons-pression gravés ; doublure bien cousue ; badge ou logo net et bien placé ; capuche et col symétriques',
    'nylon ou polyester brillant normal pour une doudoune ou un coupe-vent ; tissu technique pour les vestes outdoor (Arc\'teryx, TNF)'],
  [/\bt.?shirt|\btee\b|polo|débardeur|tank/i,
    'T-SHIRT, POLO', 'épaisseur et tenue du coton ; impression : sérigraphie opaque et nette, pas pixelisée, pas de transfert plastique ; police, taille et placement du logo ; col côtelé qui ne gondole pas ; coutures double aiguille régulières',
    'coton léger pour certains t-shirts basiques ; polyester normal pour un polo ou t-shirt de sport'],
  [/jean|denim/i,
    'JEAN', 'délavage et usure naturels (pas imprimés ni répétés), toile épaisse, surpiqûres régulières, poches arrière symétriques, rivets et bouton gravés, patch au dos, ourlet',
    'élasthanne normal pour un jean stretch'],
  [/pant|pantalon|jogger|jogging|short|cargo|trouser|tracksuit|survêt/i,
    'PANTALON, SHORT, SURVÊTEMENT', 'cordon et œillets, élastique régulier, poches symétriques et bien cousues, coutures latérales droites, logo net et bien placé, bas et chevilles',
    'polyester ou nylon normal pour un survêtement ou un short de sport ; coton molletonné pour un jogging'],
  [/knit|maille|cardigan|sweater|beanie|bonnet/i,
    'MAILLE', 'mailles régulières sans trous ni fils tirés, motif tricoté (pas imprimé) si le vrai l\'est, côtes serrées, logo tissé ou brodé net',
    'laine, coton ou acrylique selon le modèle'],
  [/\bshirt\b|chemise|overshirt/i,
    'CHEMISE', 'col symétrique et rigide, boutons alignés et bien cousus, boutonnières propres, motif aligné aux coutures, poignets, logo',
    'coton, lin ou viscose selon le modèle'],
  [/\bcap\b|casquette|\bhat\b|chapeau|bucket/i,
    'CASQUETTE, CHAPEAU', 'forme de la visière et de la couronne (symétrique, pas écrasée), broderie 3D dense sans fils sautés, œillets brodés, bande intérieure et étiquettes, fermeture arrière',
    'coton, polyester ou nylon selon le modèle'],
  [/bag|sac|tote|backpack|pochette|pouch|purse|handbag|sacoche|crossbody|speedy|neverfull|keepall/i,
    'SAC', 'forme qui se tient (pas molle ni affaissée), coutures régulières, tranches peintes lisses sans bavure, motif aligné et continu aux coutures, quincaillerie lourde gravée net, zip de marque, doublure, étiquette ou numéro intérieur',
    'toile enduite (monogramme LV, GG Supreme) qui n\'est pas du cuir ; nylon pour Prada Re-Nylon ou les sacs de sport'],
  [/wallet|portefeuille|card ?holder|porte.?carte|belt|ceinture/i,
    'PORTEFEUILLE, CEINTURE', 'coutures régulières, tranches peintes lisses, estampage du logo net et droit, boucle lourde et gravée',
    'toile enduite ou cuir selon le modèle'],
  [/watch|montre|rolex|\bap\b|audemars|omega|cartier/i,
    'MONTRE', 'alignement des index et de la lunette, marquages du cadran nets et bien espacés, aiguilles qui atteignent les index, date centrée dans sa fenêtre, couronne, finitions brossées et polies franches, bracelet et fermoir gravés',
    'les reflets sur le verre ne sont pas des défauts'],
  [/\bring\b|bague|necklace|collier|chain|chaîne|bracelet|earring|boucle d.oreille|pendant|pendentif|jewel|bijou/i,
    'BIJOU', 'épaisseur et poids apparents, gravures et poinçons nets, poli régulier sans rayures ni bulles, pierres serties droites, fermoir solide, couleur du métal homogène',
    'les reflets du métal ne sont pas des défauts'],
  [/sunglass|lunette|glasses/i,
    'LUNETTES', 'symétrie de la monture, charnières métal, gravures sur les branches, logo net, verres sans défaut, étui',
    'acétate ou métal selon le modèle'],
  [/sock|chaussette|underwear|boxer|caleçon|slip/i,
    'CHAUSSETTES, SOUS-VÊTEMENTS', 'élastique régulier, logo tissé ou imprimé net et bien placé, coutures, étiquettes',
    'coton mélangé à de l\'élasthanne ou du polyester'],
];

const GENERIC_CHECKS = 'matière anormale pour ce type d\'article (aspect plastique, tissu trop fin) ; impression floue, pixelisée ou baveuse ; logo ou police déformés (lettres mal dessinées, mauvaises proportions, mauvais espacement) ; motif mal reproduit ; quincaillerie générique ; coutures de travers, fils, colle';

// Consignes de contrôle sévère pour l'article (type reconnu dans son nom), en une ligne lisible par le modèle.
export function qcChecks(article) {
  const hit = CHECKS.find(([re]) => re.test(String(article || '')));
  if (!hit) return `Signes d'un mauvais batch : ${GENERIC_CHECKS}. Ne juge la matière que si elle est anormale pour ce type d'article.`;
  const [, name, check, normal] = hit;
  return `${name} (juge-le avec ces critères, pas comme un autre type d'article) : ${check}. NORMAL pour ce type, pas un défaut : ${normal}.`;
}
