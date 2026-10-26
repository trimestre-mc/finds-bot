-- Catalogues vendeurs (boutiques Weidian indexées automatiquement)
CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,              -- userid Weidian
  platform TEXT NOT NULL DEFAULT 'weidian',
  name TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | indexing | ok | error
  item_count INTEGER NOT NULL DEFAULT 0,
  last_indexed INTEGER,
  last_error TEXT,
  run_id TEXT,
  source TEXT,                      -- manuel, bulk, discord:<salon>, jadeship
  tier TEXT,                        -- trusted, high, mid (annuaire Jadeship)
  added_by TEXT,
  added_at INTEGER
);

-- Items indexés (ou ajoutés à la main pour Taobao / 1688)
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,              -- "<platform>:<itemId>"
  platform TEXT NOT NULL,
  item_id TEXT NOT NULL,
  shop_id TEXT,
  shop_name TEXT,
  title_zh TEXT,
  title_en TEXT,
  price_cny REAL,
  image TEXT,
  url TEXT NOT NULL,
  images TEXT,                      -- JSON : photos de la page produit (rempli au premier post)
  stock INTEGER,
  manual INTEGER NOT NULL DEFAULT 0,
  translate_failed INTEGER NOT NULL DEFAULT 0,
  posted_count INTEGER NOT NULL DEFAULT 0,
  popularity INTEGER NOT NULL DEFAULT 0,     -- ventes connues (Jadeship)
  category TEXT,                             -- shoes, hoodies… (voir categories.js)
  prev_price REAL,                           -- ancien prix si le prix a baissé
  price_changed_at INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,         -- masqué des recherches (liste noire)
  qc_count INTEGER,                          -- photos QC d'agents connues (FinderQC)
  qc_preview TEXT,                           -- JSON : quelques photos QC (FinderQC)
  qc_checked_at INTEGER,
  source TEXT,                               -- shop, jadeship, manuel
  last_posted INTEGER,
  first_seen INTEGER,
  last_seen_run TEXT
);
CREATE INDEX IF NOT EXISTS items_shop ON items(shop_id);
CREATE INDEX IF NOT EXISTS items_untranslated ON items(title_en) WHERE title_en IS NULL;
CREATE INDEX IF NOT EXISTS items_popularity ON items(popularity DESC, first_seen DESC);
CREATE INDEX IF NOT EXISTS items_category ON items(category);
CREATE INDEX IF NOT EXISTS items_nocat ON items(id) WHERE category IS NULL;
CREATE INDEX IF NOT EXISTS items_noimg ON items(item_id) WHERE images IS NULL;
CREATE INDEX IF NOT EXISTS items_qcdue ON items(qc_checked_at) WHERE popularity > 0 OR posted_count > 0 OR manual = 1;
CREATE INDEX IF NOT EXISTS items_recent ON items(first_seen DESC);

-- Liens d'affiliation des agents. template contient {url}, {url_raw}, {id} ou {platform}
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  preset TEXT,                      -- clé de AGENT_PRESETS, ou NULL pour un lien personnalisé
  code TEXT                         -- code d'affiliation (agents préréglés)
);

-- Admins ajoutés en plus des membres avec la permission Administrateur
CREATE TABLE IF NOT EXISTS admins (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT,
  PRIMARY KEY (guild_id, user_id)
);

-- Recherches en cours (pagination, sélection, "tout poster")
CREATE TABLE IF NOT EXISTS searches (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  user_id TEXT,
  params TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type INTEGER NOT NULL DEFAULT 0,   -- 0 = salon texte, 15 = forum
  created_at INTEGER
);

-- File d'attente pour "tout poster" (vidée petit à petit par le cron)
CREATE TABLE IF NOT EXISTS post_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type INTEGER NOT NULL DEFAULT 0,
  ping TEXT,                                 -- annonce (ping de rôle) envoyée avant l'item
  created_at INTEGER
);

-- Salons Discord surveillés pour découvrir des boutiques
CREATE TABLE IF NOT EXISTS sources (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT,
  added_by TEXT,
  added_at INTEGER,
  last_message_id TEXT,
  scanned_at INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  links INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

-- Items Weidian trouvés dont il faut retrouver la boutique
CREATE TABLE IF NOT EXISTS link_queue (
  item_id TEXT PRIMARY KEY,
  source TEXT,
  added_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Historique des posts (anti-doublon, statistiques, suppression)
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  thread_id TEXT,
  posted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_item_channel ON posts(item_id, channel_id, posted_at);
CREATE INDEX IF NOT EXISTS posts_at ON posts(posted_at);

-- Clics sur les boutons des cartes (redirection /go)
CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  channel_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clicks_at ON clicks(at);

-- Drops automatiques : une recherche postée régulièrement dans un salon
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  name TEXT,
  params TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type INTEGER NOT NULL DEFAULT 0,
  per_run INTEGER NOT NULL DEFAULT 3,
  every_minutes INTEGER NOT NULL DEFAULT 120,
  ping_role TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_at INTEGER NOT NULL DEFAULT 0,
  last_run INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER
);

-- Liste noire : boutiques bannies (jamais réajoutées par la découverte)
CREATE TABLE IF NOT EXISTS blacklist (
  shop_id TEXT PRIMARY KEY,
  name TEXT,
  added_at INTEGER
);

-- Salons où les liens postés par les membres sont convertis automatiquement en liens d'agents
CREATE TABLE IF NOT EXISTS convert_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT,
  last_message_id TEXT,
  converted INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER
);

-- Journal des erreurs (écran Santé)
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT,
  message TEXT
);

-- QC postés par la communauté (photo + lien d'item dans un salon surveillé)
CREATE TABLE IF NOT EXISTS qc_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  guild_id TEXT,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  images INTEGER NOT NULL DEFAULT 1,
  author_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS qc_posts_item ON qc_posts(item_id, at);

-- Salons où les membres postent leurs QC (lus toutes les 2 min, sans réponse du bot)
CREATE TABLE IF NOT EXISTS qc_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT,
  last_message_id TEXT,
  collected INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER
);

-- Cache des recherches identiques (6 h)
CREATE TABLE IF NOT EXISTS search_cache (
  key TEXT PRIMARY KEY,
  ids TEXT NOT NULL,
  at INTEGER NOT NULL
);
