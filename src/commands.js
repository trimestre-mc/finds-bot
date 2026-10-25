// Une seule commande : /menu ouvre le panneau. Tout le reste passe par des boutons.
// (Enregistrée via POST /api/register-commands, qui remplace aussi les anciennes commandes.)

export const COMMANDS = [
  {
    name: 'menu',
    description: 'Ouvrir le panneau Finds : recherche, catalogues, agents, accès',
    contexts: [0],
    integration_types: [0],
  },
];
