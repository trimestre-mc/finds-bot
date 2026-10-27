// Commandes : /menu (panneau admin), /find, /qc, /convert et /coupon (ouvertes à tous les membres).
// Enregistrées via POST /api/setup, qui remplace aussi les anciennes commandes.

import { CATEGORIES } from './categories.js';

const STRING = 3, NUMBER = 10;
const base = { contexts: [0], integration_types: [0] };

export const COMMANDS = [
  {
    ...base,
    name: 'menu',
    description: 'Ouvrir le panneau Finds : recherche, catalogues, drops, stats, réglages',
  },
  {
    ...base,
    name: 'find',
    description: 'Chercher un item (ex : hoodie, jordan 4, bag) et l\'acheter avec le bon lien',
    options: [
      { type: STRING, name: 'recherche', description: 'Ce que tu cherches (en anglais, c\'est mieux)', required: true, max_length: 100 },
      {
        type: STRING, name: 'categorie', description: 'Limiter à une catégorie', required: false,
        choices: CATEGORIES.map((c) => ({ name: c.label, value: c.key })),
      },
      { type: NUMBER, name: 'prix_max', description: 'Prix maximum (dans la devise du serveur)', required: false, min_value: 0 },
    ],
  },
  {
    ...base,
    name: 'qc',
    description: 'Voir les photos QC d\'un item (Weidian, Taobao, 1688 ou lien d\'agent)',
    options: [{ type: STRING, name: 'lien', description: 'Le lien de l\'item', required: true, max_length: 500 }],
  },
  {
    ...base,
    name: 'coupon',
    description: 'Les coupons et liens d\'inscription aux agents (réductions sur ta première commande)',
  },
  {
    ...base,
    name: 'convert',
    description: 'Transformer un lien Weidian, Taobao, 1688 ou d\'agent en liens d\'achat',
    options: [{ type: STRING, name: 'lien', description: 'Le lien à convertir', required: true, max_length: 500 }],
  },
];
