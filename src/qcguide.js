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

const GENERAL = 'Une marque a souvent plusieurs logos officiels (box, script, gothique, petit logo, ton sur ton) : ne pénalise pas un logo parce que ce n\'est pas la version la plus connue ; juge la qualité de son exécution.';

// Points d'expert de la marque de l'article (texte vide si marque inconnue ou non listée).
export function qcGuide(article) {
  const text = String(article || '');
  const hits = GUIDE.filter(([re]) => re.test(text)).map(([, tip]) => tip);
  return hits.length ? `Points d'expert pour cette marque : ${hits.slice(0, 2).join(' ')} ${GENERAL}` : GENERAL;
}
