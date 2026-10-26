-- Index partiels : les tâches de fond lisent seulement les items qui les concernent (quota de lectures D1).
CREATE INDEX IF NOT EXISTS items_nocat ON items(id) WHERE category IS NULL;
CREATE INDEX IF NOT EXISTS items_noimg ON items(item_id) WHERE images IS NULL;
CREATE INDEX IF NOT EXISTS items_qcdue ON items(qc_checked_at) WHERE popularity > 0 OR posted_count > 0 OR manual = 1;
