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
  source TEXT,                               -- shop, jadeship, manuel
  last_posted INTEGER,
  first_seen INTEGER,
  last_seen_run TEXT
);
CREATE INDEX IF NOT EXISTS items_shop ON items(shop_id);
CREATE INDEX IF NOT EXISTS items_untranslated ON items(title_en) WHERE title_en IS NULL;

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
