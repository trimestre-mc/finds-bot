// Définition des commandes slash (enregistrées via /api/register-commands).

const STRING = 3, INTEGER = 4, BOOLEAN = 5, USER = 6, CHANNEL = 7, NUMBER = 10;
const SUB = 1;
const GUILD_TEXT = 0, GUILD_ANNOUNCEMENT = 5;

const base = { contexts: [0], integration_types: [0] };

export const COMMANDS = [
  {
    ...base,
    name: 'catalogue',
    description: 'Gérer les catalogues vendeurs indexés',
    options: [
      {
        type: SUB, name: 'ajouter', description: 'Ajouter une boutique Weidian à indexer',
        options: [{ type: STRING, name: 'lien', description: 'Lien de la boutique (ou d\'un item de la boutique)', required: true }],
      },
      { type: SUB, name: 'liste', description: 'Voir les catalogues et leur état' },
      {
        type: SUB, name: 'retirer', description: 'Retirer un catalogue et ses items',
        options: [{ type: STRING, name: 'id', description: 'ID de la boutique', required: true, autocomplete: true }],
      },
      {
        type: SUB, name: 'reindexer', description: 'Relancer l\'indexation d\'un catalogue',
        options: [{ type: STRING, name: 'id', description: 'ID de la boutique', required: true, autocomplete: true }],
      },
    ],
  },
  {
    ...base,
    name: 'recherche',
    description: 'Chercher dans les items indexés et les poster',
    options: [
      { type: STRING, name: 'mots', description: 'Ex : bag, hoodie, jordan 4… (laisser vide = tout)', required: false },
      {
        type: CHANNEL, name: 'salon', description: 'Salon où poster (par défaut : ici)',
        channel_types: [GUILD_TEXT, GUILD_ANNOUNCEMENT], required: false,
      },
      { type: NUMBER, name: 'prix_min', description: 'Prix minimum en €', required: false, min_value: 0 },
      { type: NUMBER, name: 'prix_max', description: 'Prix maximum en €', required: false, min_value: 0 },
      { type: STRING, name: 'vendeur', description: 'Limiter à un vendeur', required: false, autocomplete: true },
      { type: BOOLEAN, name: 'inclure_postes', description: 'Inclure les items déjà postés (non par défaut)', required: false },
    ],
  },
  {
    ...base,
    name: 'item',
    description: 'Ajouter un item à la main (Taobao, 1688 ou Weidian)',
    options: [
      {
        type: SUB, name: 'ajouter', description: 'Ajouter un item à la main',
        options: [
          { type: STRING, name: 'lien', description: 'Lien Taobao, 1688 ou Weidian de l\'item', required: true },
          { type: STRING, name: 'titre', description: 'Titre (rempli tout seul pour Weidian)', required: false },
          { type: NUMBER, name: 'prix', description: 'Prix en ¥ (rempli tout seul pour Weidian)', required: false, min_value: 0 },
          { type: STRING, name: 'image', description: 'Lien de l\'image (rempli tout seul pour Weidian)', required: false },
        ],
      },
    ],
  },
  {
    ...base,
    name: 'agent',
    description: 'Configurer les liens d\'affiliation des agents',
    options: [
      {
        type: SUB, name: 'ajouter', description: 'Ajouter ou modifier un agent',
        options: [
          { type: STRING, name: 'nom', description: 'Nom affiché sur le bouton, ex : BBDBuy', required: true, max_length: 40 },
          {
            type: STRING, name: 'modele', required: true,
            description: 'Lien avec {url} à la place du lien produit, ex : https://...?url={url}&code=TONCODE',
          },
          { type: INTEGER, name: 'position', description: 'Ordre du bouton (1 = premier)', required: false, min_value: 1, max_value: 20 },
        ],
      },
      { type: SUB, name: 'liste', description: 'Voir les agents configurés' },
      {
        type: SUB, name: 'retirer', description: 'Retirer un agent',
        options: [{ type: STRING, name: 'nom', description: 'Nom de l\'agent', required: true, autocomplete: true }],
      },
    ],
  },
  {
    ...base,
    name: 'admin',
    description: 'Gérer qui peut utiliser le bot',
    options: [
      {
        type: SUB, name: 'ajouter', description: 'Donner l\'accès au bot à un membre',
        options: [{ type: USER, name: 'membre', description: 'Membre', required: true }],
      },
      {
        type: SUB, name: 'retirer', description: 'Retirer l\'accès à un membre',
        options: [{ type: USER, name: 'membre', description: 'Membre', required: true }],
      },
      { type: SUB, name: 'liste', description: 'Voir les membres ajoutés' },
    ],
  },
  {
    ...base,
    name: 'statut',
    description: 'État du bot : items, traductions, file d\'attente',
  },
];
