-- Phase 1 read-only catalog pilot. This is SQLite/D1 SQL, not a PostgreSQL dump.
-- Supabase remains the production source of truth.
CREATE TABLE IF NOT EXISTS menu_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '•',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  business_id INTEGER NOT NULL,
  image_url TEXT
);

CREATE TABLE IF NOT EXISTS menu (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL,
  category TEXT NOT NULL,
  available INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  kot_group_id INTEGER,
  nature TEXT NOT NULL DEFAULT 'Goods',
  unit TEXT NOT NULL DEFAULT 'ea',
  tax_rate NUMERIC NOT NULL DEFAULT 5,
  cgst_rate NUMERIC NOT NULL DEFAULT 2.5,
  sgst_rate NUMERIC NOT NULL DEFAULT 2.5,
  igst_rate NUMERIC NOT NULL DEFAULT 5,
  tax_mode TEXT NOT NULL DEFAULT 'exclusive',
  tax_label TEXT NOT NULL DEFAULT 'GST 5%',
  channel_prices TEXT NOT NULL DEFAULT '{}',
  category_id INTEGER,
  image_url TEXT,
  business_id INTEGER NOT NULL,
  option_set_ids TEXT NOT NULL DEFAULT '[]',
  qr_available INTEGER NOT NULL DEFAULT 1,
  sku TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sales_channels TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  is_open_item INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_variants (
  id INTEGER PRIMARY KEY,
  menu_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sku TEXT,
  price NUMERIC NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'ea',
  channel_prices TEXT NOT NULL DEFAULT '{}',
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  business_id INTEGER NOT NULL,
  option_set_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_menu_business_available
  ON menu (business_id, available);
CREATE INDEX IF NOT EXISTS idx_menu_business_sku
  ON menu (business_id, upper(sku));
CREATE INDEX IF NOT EXISTS idx_menu_categories_business_active_sort
  ON menu_categories (business_id, active, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_menu_variants_business_menu
  ON menu_variants (business_id, menu_id, available);
