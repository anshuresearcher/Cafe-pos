-- Full public-app schema translated from the PostgreSQL backup to SQLite/D1.
-- PostgreSQL RLS policies and server functions/non-check triggers are not executable in D1;
-- tenant authorization must be enforced by the Worker/API. CHECK rules are in 0002.

CREATE TABLE IF NOT EXISTS "api_rate_limits" (
  "bucket_key" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "window_started_at" TEXT NOT NULL,
  "hit_count" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("bucket_key")
);

CREATE TABLE IF NOT EXISTS "app_sessions" (
  "token" TEXT NOT NULL,
  "user_id" INTEGER NOT NULL,
  "expires_at" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER,
  "device_id" TEXT,
  "token_hash" TEXT NOT NULL,
  PRIMARY KEY ("token")
);

CREATE TABLE IF NOT EXISTS "auth_login_attempts" (
  "identity_key" TEXT NOT NULL,
  "window_started_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "locked_until" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("identity_key")
);

CREATE TABLE IF NOT EXISTS "businesses" (
  "id" INTEGER PRIMARY KEY,
  "business_code" TEXT NOT NULL,
  "business_name" TEXT NOT NULL,
  "password_hash" TEXT,
  "profile_id" INTEGER,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_type" TEXT DEFAULT 'Cafe',
  "owner_name" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "address" TEXT,
  "city" TEXT,
  "state" TEXT,
  "gstin" TEXT,
  "logo_url" TEXT,
  "currency" TEXT DEFAULT '₹',
  FOREIGN KEY ("profile_id") REFERENCES "access_profiles" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "network_usage_hourly" (
  "bucket_start" TEXT NOT NULL,
  "business_id" INTEGER NOT NULL DEFAULT 0,
  "device_id" TEXT NOT NULL DEFAULT '',
  "user_id" INTEGER NOT NULL DEFAULT 0,
  "route_key" TEXT NOT NULL,
  "http_method" TEXT NOT NULL,
  "feature" TEXT NOT NULL,
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "response_bytes" INTEGER NOT NULL DEFAULT 0,
  "response_time_ms_total" NUMERIC NOT NULL DEFAULT 0,
  "response_time_ms_max" NUMERIC NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "db_query_count" INTEGER NOT NULL DEFAULT 0,
  "db_duration_ms_total" NUMERIC NOT NULL DEFAULT 0,
  "db_rows" INTEGER NOT NULL DEFAULT 0,
  "db_result_bytes_est" INTEGER NOT NULL DEFAULT 0,
  "db_size_sample_count" INTEGER NOT NULL DEFAULT 0,
  "db_error_count" INTEGER NOT NULL DEFAULT 0,
  "last_activity_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("bucket_start", "business_id", "device_id", "user_id", "route_key", "http_method", "feature")
);

CREATE TABLE IF NOT EXISTS "support_users" (
  "id" INTEGER PRIMARY KEY,
  "username" TEXT NOT NULL,
  "display_name" TEXT NOT NULL DEFAULT 'Support',
  "password_hash" TEXT NOT NULL,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "users" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "password" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'cashier',
  "active" INTEGER DEFAULT 1,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "access_profiles" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "permissions" TEXT NOT NULL DEFAULT '{}',
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "app_settings" (
  "id" INTEGER PRIMARY KEY,
  "settings" TEXT NOT NULL DEFAULT '{}',
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "billing_adjustments" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "calculation" TEXT NOT NULL,
  "value" NUMERIC NOT NULL,
  "applies_to" TEXT NOT NULL DEFAULT 'all',
  "description" TEXT,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  "application_level" TEXT NOT NULL DEFAULT 'order',
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "business_licenses" (
  "id" INTEGER PRIMARY KEY,
  "business_id" INTEGER NOT NULL,
  "plan" TEXT NOT NULL DEFAULT 'Trial',
  "status" TEXT NOT NULL DEFAULT 'active',
  "starts_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TEXT NOT NULL,
  "max_devices" INTEGER NOT NULL DEFAULT 1,
  "notes" TEXT,
  "created_by_support_user_id" INTEGER,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TEXT,
  "license_type" TEXT NOT NULL DEFAULT 'Trial',
  "duration_months" INTEGER NOT NULL DEFAULT 1,
  "add_on" TEXT,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "business_sequence_counters" (
  "business_id" INTEGER NOT NULL,
  "series_key" TEXT NOT NULL,
  "next_number" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("business_id", "series_key"),
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "customers" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  "gstin" TEXT,
  "birth_date" TEXT,
  "address" TEXT,
  "city" TEXT,
  "state" TEXT,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "expense_categories" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "invoice_number_counters" (
  "business_id" INTEGER PRIMARY KEY,
  "next_number" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "kot_device_print_hosts" (
  "business_id" INTEGER PRIMARY KEY,
  "enabled" INTEGER NOT NULL DEFAULT 0,
  "host_device_id" TEXT,
  "last_heartbeat" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "kot_groups" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "station" TEXT NOT NULL DEFAULT 'Kitchen',
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  "printer_id" INTEGER,
  "category_names" TEXT NOT NULL DEFAULT '[]',
  "item_ids" TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "loyalty_settings" (
  "id" INTEGER PRIMARY KEY,
  "points_per_currency" NUMERIC NOT NULL DEFAULT 1,
  "currency_per_point" NUMERIC NOT NULL DEFAULT 1,
  "min_redeem_points" INTEGER NOT NULL DEFAULT 100,
  "welcome_points" INTEGER NOT NULL DEFAULT 0,
  "enabled" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "menu_categories" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "icon" TEXT NOT NULL DEFAULT '•',
  "active" INTEGER NOT NULL DEFAULT 1,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  "image_url" TEXT,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "printers" (
  "id" INTEGER PRIMARY KEY,
  "business_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "connection_type" TEXT NOT NULL DEFAULT 'local',
  "host" TEXT,
  "port" INTEGER NOT NULL DEFAULT 9100,
  "bluetooth_name" TEXT,
  "service_uuid" TEXT NOT NULL DEFAULT '000018f0-0000-1000-8000-00805f9b34fb',
  "characteristic_uuid" TEXT NOT NULL DEFAULT '00002af1-0000-1000-8000-00805f9b34fb',
  "paper_width" TEXT NOT NULL DEFAULT '80',
  "is_default" INTEGER NOT NULL DEFAULT 0,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "public_menu_push_subscriptions" (
  "id" INTEGER PRIMARY KEY,
  "business_id" INTEGER NOT NULL,
  "endpoint" TEXT NOT NULL,
  "subscription" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "public_menu_settings" (
  "business_id" INTEGER PRIMARY KEY,
  "token" TEXT NOT NULL,
  "enabled" INTEGER NOT NULL DEFAULT 0,
  "price_channel" TEXT NOT NULL DEFAULT 'online',
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "public_base_url" TEXT,
  "category_order" TEXT NOT NULL DEFAULT '[]',
  "outlet_open" INTEGER NOT NULL DEFAULT 1,
  "hours_enabled" INTEGER NOT NULL DEFAULT 0,
  "open_time" TEXT NOT NULL DEFAULT '09:00',
  "close_time" TEXT NOT NULL DEFAULT '22:00',
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "qr_guest_otp_challenges" (
  "id" TEXT NOT NULL,
  "business_id" INTEGER NOT NULL,
  "menu_token_hash" TEXT NOT NULL,
  "table_number" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "provider_request_id" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TEXT NOT NULL,
  "resend_after" TEXT NOT NULL,
  "verified_at" TEXT,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "qr_service_requests" (
  "id" INTEGER PRIMARY KEY,
  "business_id" INTEGER NOT NULL,
  "table_number" TEXT NOT NULL,
  "request_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "reservations" (
  "id" INTEGER PRIMARY KEY,
  "customer_name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "reservation_date" TEXT NOT NULL,
  "reservation_time" TEXT NOT NULL,
  "guests" INTEGER NOT NULL,
  "table_number" TEXT,
  "status" TEXT DEFAULT 'Reserved',
  "notes" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "restaurant_tables" (
  "id" INTEGER PRIMARY KEY,
  "table_number" TEXT NOT NULL,
  "capacity" INTEGER NOT NULL DEFAULT 4,
  "status" TEXT NOT NULL DEFAULT 'Available',
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "support_business_branding" (
  "business_id" INTEGER PRIMARY KEY,
  "show_powered_by_cafe_pilot" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "support_sessions" (
  "token" TEXT NOT NULL,
  "support_user_id" INTEGER NOT NULL,
  "expires_at" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "token_hash" TEXT NOT NULL,
  PRIMARY KEY ("token"),
  FOREIGN KEY ("support_user_id") REFERENCES "support_users" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "app_users" (
  "id" INTEGER PRIMARY KEY,
  "display_name" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "profile_id" INTEGER,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "password_hash" TEXT,
  "business_id" INTEGER NOT NULL,
  "permissions_override" TEXT,
  "is_owner" INTEGER NOT NULL DEFAULT 0,
  "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
  "is_blocked" INTEGER NOT NULL DEFAULT 0,
  "blocked_at" TEXT,
  "blocked_by_user_id" INTEGER,
  "blocked_by_support_user_id" INTEGER,
  "block_reason" TEXT,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("profile_id") REFERENCES "access_profiles" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "device_registration_keys" (
  "id" INTEGER PRIMARY KEY,
  "business_id" INTEGER NOT NULL,
  "license_id" INTEGER,
  "key_hash" TEXT NOT NULL,
  "key_hint" TEXT NOT NULL,
  "device_name" TEXT,
  "status" TEXT NOT NULL DEFAULT 'unused',
  "created_by_type" TEXT NOT NULL DEFAULT 'admin',
  "created_by_user_id" INTEGER,
  "expires_at" TEXT,
  "used_at" TEXT,
  "used_device_id" INTEGER,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("license_id") REFERENCES "business_licenses" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "loyalty_transactions" (
  "id" INTEGER PRIMARY KEY,
  "customer_id" INTEGER NOT NULL,
  "points" INTEGER NOT NULL,
  "transaction_type" TEXT NOT NULL,
  "reference_type" TEXT,
  "reference_id" INTEGER,
  "note" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "menu" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "price" NUMERIC NOT NULL,
  "category" TEXT NOT NULL,
  "available" INTEGER DEFAULT 1,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
  "kot_group_id" INTEGER,
  "nature" TEXT NOT NULL DEFAULT 'Goods',
  "unit" TEXT NOT NULL DEFAULT 'ea',
  "tax_rate" NUMERIC NOT NULL DEFAULT 5,
  "cgst_rate" NUMERIC NOT NULL DEFAULT 2.5,
  "sgst_rate" NUMERIC NOT NULL DEFAULT 2.5,
  "igst_rate" NUMERIC NOT NULL DEFAULT 5,
  "tax_mode" TEXT NOT NULL DEFAULT 'exclusive',
  "tax_label" TEXT NOT NULL DEFAULT 'GST 5%',
  "channel_prices" TEXT NOT NULL DEFAULT '{}',
  "category_id" INTEGER,
  "image_url" TEXT,
  "business_id" INTEGER NOT NULL,
  "option_set_ids" TEXT NOT NULL DEFAULT '[]',
  "qr_available" INTEGER NOT NULL DEFAULT 1,
  "sku" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "sales_channels" TEXT,
  "tags" TEXT NOT NULL DEFAULT '[]',
  "is_open_item" INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("category_id") REFERENCES "menu_categories" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("kot_group_id") REFERENCES "kot_groups" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "orders" (
  "id" INTEGER PRIMARY KEY,
  "order_number" TEXT NOT NULL,
  "order_type" TEXT NOT NULL,
  "table_number" TEXT,
  "subtotal" NUMERIC NOT NULL,
  "gst" NUMERIC NOT NULL,
  "total" NUMERIC NOT NULL,
  "payment_method" TEXT,
  "status" TEXT DEFAULT 'Pending',
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
  "customer_id" INTEGER,
  "discount" NUMERIC NOT NULL DEFAULT 0,
  "service_charge" NUMERIC NOT NULL DEFAULT 0,
  "notes" TEXT,
  "adjustment_meta" TEXT NOT NULL DEFAULT '{}',
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "discount_adjustment_id" INTEGER,
  "charge_adjustment_id" INTEGER,
  "business_id" INTEGER NOT NULL,
  "marketing_deal_id" TEXT,
  "marketing_deal_name" TEXT,
  "bill_printed_at" TEXT,
  "discount_adjustment_name" TEXT,
  "charge_adjustment_name" TEXT,
  "pax" INTEGER,
  "public_tracking_token" TEXT,
  "non_chargeable_reason" TEXT,
  "cancellation_reason" TEXT,
  "cancelled_by_user_id" INTEGER,
  "cancelled_at" TEXT,
  "sales_channel_key" TEXT,
  "sales_channel_name" TEXT,
  "public_session_key" TEXT,
  "billing_settings_snapshot" TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "qr_guest_sessions" (
  "id" INTEGER PRIMARY KEY,
  "business_id" INTEGER NOT NULL,
  "menu_token_hash" TEXT NOT NULL,
  "table_number" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "customer_id" INTEGER,
  "session_token_hash" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_activity_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TEXT NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "registered_devices" (
  "id" INTEGER PRIMARY KEY,
  "business_id" INTEGER NOT NULL,
  "license_id" INTEGER,
  "device_id" TEXT NOT NULL,
  "device_name" TEXT NOT NULL DEFAULT 'POS Device',
  "device_type" TEXT NOT NULL DEFAULT 'Web',
  "status" TEXT NOT NULL DEFAULT 'active',
  "registration_key_id" INTEGER,
  "registered_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_ip" TEXT,
  "user_agent" TEXT,
  "revoked_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("license_id") REFERENCES "business_licenses" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "expenses" (
  "id" INTEGER PRIMARY KEY,
  "category_id" INTEGER,
  "amount" NUMERIC NOT NULL,
  "payment_method" TEXT NOT NULL DEFAULT 'Cash',
  "expense_date" TEXT NOT NULL,
  "note" TEXT,
  "created_by" INTEGER,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("category_id") REFERENCES "expense_categories" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("created_by") REFERENCES "app_users" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "invoices" (
  "id" INTEGER PRIMARY KEY,
  "invoice_number" TEXT NOT NULL,
  "order_id" INTEGER NOT NULL,
  "customer_id" INTEGER,
  "invoice_date" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "subtotal" NUMERIC NOT NULL DEFAULT 0,
  "gst" NUMERIC NOT NULL DEFAULT 0,
  "total" NUMERIC NOT NULL DEFAULT 0,
  "payment_method" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Generated',
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "kot_device_print_jobs" (
  "id" INTEGER PRIMARY KEY,
  "business_id" INTEGER NOT NULL,
  "order_id" INTEGER NOT NULL,
  "ticket_number" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimed_by_device_id" TEXT,
  "lease_until" TEXT,
  "next_attempt_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "printed_at" TEXT,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "marketing_push_campaigns" (
  "id" INTEGER PRIMARY KEY,
  "business_id" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "target_url" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'sending',
  "subscriber_count" INTEGER NOT NULL DEFAULT 0,
  "sent_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "created_by" INTEGER,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at" TEXT,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("created_by") REFERENCES "app_users" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "menu_variants" (
  "id" INTEGER PRIMARY KEY,
  "menu_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "sku" TEXT,
  "price" NUMERIC NOT NULL DEFAULT 0,
  "unit" TEXT NOT NULL DEFAULT 'ea',
  "channel_prices" TEXT NOT NULL DEFAULT '{}',
  "available" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  "option_set_ids" TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("menu_id") REFERENCES "menu" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "order_activity" (
  "id" INTEGER PRIMARY KEY,
  "order_id" INTEGER NOT NULL,
  "event_type" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "actor" TEXT NOT NULL DEFAULT 'System',
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  "actor_user_id" INTEGER,
  FOREIGN KEY ("actor_user_id") REFERENCES "app_users" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "order_adjustment_audit" (
  "id" INTEGER PRIMARY KEY,
  "order_id" INTEGER NOT NULL,
  "changed_by" INTEGER,
  "change_type" TEXT NOT NULL,
  "old_discount" NUMERIC NOT NULL DEFAULT 0,
  "new_discount" NUMERIC NOT NULL DEFAULT 0,
  "old_service_charge" NUMERIC NOT NULL DEFAULT 0,
  "new_service_charge" NUMERIC NOT NULL DEFAULT 0,
  "reason" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "payments" (
  "id" INTEGER PRIMARY KEY,
  "order_id" INTEGER NOT NULL,
  "order_number" TEXT NOT NULL,
  "amount" NUMERIC NOT NULL,
  "payment_method" TEXT NOT NULL,
  "payment_status" TEXT DEFAULT 'Paid',
  "transaction_id" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" INTEGER NOT NULL,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "qr_menu_events" (
  "id" INTEGER PRIMARY KEY,
  "business_id" INTEGER NOT NULL,
  "session_key" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "item_count" INTEGER NOT NULL DEFAULT 0,
  "order_id" INTEGER,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "order_items" (
  "id" INTEGER PRIMARY KEY,
  "order_id" INTEGER NOT NULL,
  "menu_id" INTEGER,
  "item_name" TEXT NOT NULL,
  "price" NUMERIC NOT NULL,
  "quantity" INTEGER NOT NULL,
  "line_total" NUMERIC NOT NULL,
  "variant_id" INTEGER,
  "unit" TEXT,
  "tax_rate" NUMERIC NOT NULL DEFAULT 5,
  "tax_mode" TEXT NOT NULL DEFAULT 'exclusive',
  "business_id" INTEGER NOT NULL,
  "options" TEXT NOT NULL DEFAULT '[]',
  "item_discount_rule_id" INTEGER,
  "item_discount_amount" NUMERIC NOT NULL DEFAULT 0,
  "item_discount_name" TEXT,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("menu_id") REFERENCES "menu" ("id"),
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("variant_id") REFERENCES "menu_variants" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "kot" (
  "id" INTEGER PRIMARY KEY,
  "order_id" INTEGER NOT NULL,
  "item_name" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "status" TEXT DEFAULT 'Pending',
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
  "kot_group_id" INTEGER,
  "business_id" INTEGER NOT NULL,
  "options" TEXT NOT NULL DEFAULT '[]',
  "order_item_id" INTEGER,
  "cancelled_quantity" INTEGER NOT NULL DEFAULT 0,
  "ticket_number" INTEGER NOT NULL DEFAULT 1,
  "prep_started_at" TEXT,
  "prep_completed_at" TEXT,
  FOREIGN KEY ("business_id") REFERENCES "businesses" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("kot_group_id") REFERENCES "kot_groups" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("order_item_id") REFERENCES "order_items" ("id") ON DELETE SET NULL
);

-- Private import helper for values that exceed D1's SQL statement limit.
CREATE TABLE IF NOT EXISTS "_migration_import_chunks" (
  "owner_table" TEXT NOT NULL, "owner_key" TEXT NOT NULL,
  "column_name" TEXT NOT NULL, "chunk_index" INTEGER NOT NULL, "chunk_value" TEXT NOT NULL,
  PRIMARY KEY ("owner_table", "owner_key", "column_name", "chunk_index")
);

-- PostgreSQL indexes translated to SQLite/D1.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_access_profiles_business_name" ON "access_profiles" (business_id, name);
CREATE INDEX IF NOT EXISTS "idx_app_sessions_device_id" ON "app_sessions" (device_id);
CREATE INDEX IF NOT EXISTS "idx_app_sessions_expires_at" ON "app_sessions" (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_sessions_one_per_user" ON "app_sessions" (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_sessions_token_hash" ON "app_sessions" (token_hash);
CREATE INDEX IF NOT EXISTS "idx_app_sessions_user_business" ON "app_sessions" (user_id, business_id);
CREATE INDEX IF NOT EXISTS "idx_app_settings_business_id" ON "app_settings" (business_id);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_settings_business_id_unique" ON "app_settings" (business_id);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_users_business_username" ON "app_users" (business_id, lower((username)));
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_users_one_owner_per_business" ON "app_users" (business_id) WHERE (is_owner = true);
CREATE INDEX IF NOT EXISTS "idx_auth_login_attempts_updated_at" ON "auth_login_attempts" (updated_at);
CREATE INDEX IF NOT EXISTS "idx_billing_adjustments_business_id" ON "billing_adjustments" (business_id);
CREATE INDEX IF NOT EXISTS "idx_billing_adjustments_kind_active" ON "billing_adjustments" (kind, active);
CREATE INDEX IF NOT EXISTS "idx_business_licenses_business_id" ON "business_licenses" (business_id, id DESC);
CREATE INDEX IF NOT EXISTS "idx_business_licenses_business_status" ON "business_licenses" (business_id, status);
CREATE INDEX IF NOT EXISTS "idx_business_sequence_counters_business_id" ON "business_sequence_counters" (business_id);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_businesses_business_code" ON "businesses" (business_code);
CREATE INDEX IF NOT EXISTS "idx_customers_business_created_at" ON "customers" (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_customers_business_id" ON "customers" (business_id);
CREATE INDEX IF NOT EXISTS "idx_device_registration_keys_business_id" ON "device_registration_keys" (business_id, status);
CREATE INDEX IF NOT EXISTS "idx_expense_categories_business_id" ON "expense_categories" (business_id);
CREATE INDEX IF NOT EXISTS "idx_expenses_business_id" ON "expenses" (business_id);
CREATE INDEX IF NOT EXISTS "idx_expenses_date" ON "expenses" (expense_date DESC);
CREATE INDEX IF NOT EXISTS "idx_invoice_number_counters_business_id" ON "invoice_number_counters" (business_id);
CREATE INDEX IF NOT EXISTS "idx_invoices_business_id" ON "invoices" (business_id);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invoices_business_invoice_number" ON "invoices" (business_id, invoice_number);
CREATE INDEX IF NOT EXISTS "idx_kot_business_created_at" ON "kot" (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_kot_business_id" ON "kot" (business_id);
CREATE INDEX IF NOT EXISTS "idx_kot_business_id_id" ON "kot" (business_id, id);
CREATE INDEX IF NOT EXISTS "idx_kot_device_print_jobs_pending" ON "kot_device_print_jobs" (business_id, status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS "idx_kot_groups_business_id" ON "kot_groups" (business_id);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_kot_order_item_unique" ON "kot" (business_id, order_item_id) WHERE (order_item_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS "idx_loyalty_customer" ON "loyalty_transactions" (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_loyalty_settings_business_id" ON "loyalty_settings" (business_id);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_loyalty_settings_business_unique" ON "loyalty_settings" (business_id);
CREATE INDEX IF NOT EXISTS "idx_loyalty_transactions_business_id" ON "loyalty_transactions" (business_id);
CREATE INDEX IF NOT EXISTS "idx_marketing_push_campaigns_business" ON "marketing_push_campaigns" (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_marketing_push_campaigns_business_id" ON "marketing_push_campaigns" (business_id);
CREATE INDEX IF NOT EXISTS "idx_menu_business_available" ON "menu" (business_id, available);
CREATE INDEX IF NOT EXISTS "idx_menu_business_id" ON "menu" (business_id);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_menu_business_sku_unique" ON "menu" (business_id, upper((sku)));
CREATE INDEX IF NOT EXISTS "idx_menu_categories_active_sort" ON "menu_categories" (active, sort_order, name);
CREATE INDEX IF NOT EXISTS "idx_menu_categories_business_active" ON "menu_categories" (business_id, active);
CREATE INDEX IF NOT EXISTS "idx_menu_categories_business_id" ON "menu_categories" (business_id);
CREATE INDEX IF NOT EXISTS "idx_menu_variants_business_id" ON "menu_variants" (business_id);
CREATE INDEX IF NOT EXISTS "idx_menu_variants_menu" ON "menu_variants" (menu_id);
CREATE INDEX IF NOT EXISTS "idx_network_usage_hourly_business" ON "network_usage_hourly" (bucket_start DESC, business_id);
CREATE INDEX IF NOT EXISTS "idx_network_usage_hourly_device" ON "network_usage_hourly" (bucket_start DESC, business_id, device_id);
CREATE INDEX IF NOT EXISTS "idx_network_usage_hourly_endpoint" ON "network_usage_hourly" (bucket_start DESC, route_key);
CREATE INDEX IF NOT EXISTS "idx_order_activity_business_id" ON "order_activity" (business_id);
CREATE INDEX IF NOT EXISTS "idx_order_activity_business_id_id" ON "order_activity" (business_id, id);
CREATE INDEX IF NOT EXISTS "idx_order_activity_order_time" ON "order_activity" (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_order_items_business_id" ON "order_items" (business_id);
CREATE INDEX IF NOT EXISTS "idx_order_items_order_id" ON "order_items" (order_id);
CREATE INDEX IF NOT EXISTS "idx_orders_business_created_at" ON "orders" (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_orders_business_id" ON "orders" (business_id);
CREATE INDEX IF NOT EXISTS "idx_orders_cancelled_report" ON "orders" (business_id, cancelled_at DESC) WHERE ((status) = 'Cancelled');
CREATE INDEX IF NOT EXISTS "idx_orders_public_session_active" ON "orders" (business_id, public_session_key, id DESC) WHERE public_session_key IS NOT NULL AND status NOT IN ('Completed', 'Cancelled');
CREATE INDEX IF NOT EXISTS "idx_payments_business_created_at" ON "payments" (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_payments_business_id" ON "payments" (business_id);
CREATE INDEX IF NOT EXISTS "idx_payments_order_business_status" ON "payments" (order_id, business_id, payment_status);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_printers_business_default" ON "printers" (business_id) WHERE (is_default = true);
CREATE INDEX IF NOT EXISTS "idx_printers_business_id" ON "printers" (business_id);
CREATE INDEX IF NOT EXISTS "idx_public_menu_push_subscriptions_business" ON "public_menu_push_subscriptions" (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_public_menu_push_subscriptions_business_id" ON "public_menu_push_subscriptions" (business_id);
CREATE INDEX IF NOT EXISTS "idx_public_menu_settings_business_id" ON "public_menu_settings" (business_id);
CREATE INDEX IF NOT EXISTS "idx_qr_menu_events_business_id" ON "qr_menu_events" (business_id);
CREATE INDEX IF NOT EXISTS "idx_qr_menu_events_business_session" ON "qr_menu_events" (business_id, session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_qr_menu_events_business_time" ON "qr_menu_events" (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_qr_service_requests_business_id" ON "qr_service_requests" (business_id);
CREATE INDEX IF NOT EXISTS "idx_qr_service_requests_business_time" ON "qr_service_requests" (business_id, id DESC);
CREATE INDEX IF NOT EXISTS "idx_registered_devices_business_id" ON "registered_devices" (business_id, status);
CREATE INDEX IF NOT EXISTS "idx_registered_devices_business_status" ON "registered_devices" (business_id, status);
CREATE INDEX IF NOT EXISTS "idx_reservations_business_created_at" ON "reservations" (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "idx_reservations_business_id" ON "reservations" (business_id);
CREATE INDEX IF NOT EXISTS "idx_restaurant_tables_business_id" ON "restaurant_tables" (business_id);
CREATE INDEX IF NOT EXISTS "idx_support_sessions_expires_at" ON "support_sessions" (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_support_sessions_token_hash" ON "support_sessions" (token_hash);
CREATE INDEX IF NOT EXISTS "idx_support_sessions_user_id" ON "support_sessions" (support_user_id);
CREATE INDEX IF NOT EXISTS "qr_guest_otp_expiry_idx" ON "qr_guest_otp_challenges" (expires_at);
CREATE INDEX IF NOT EXISTS "qr_guest_otp_lookup_idx" ON "qr_guest_otp_challenges" (business_id, menu_token_hash, table_number, phone, created_at DESC);
CREATE INDEX IF NOT EXISTS "qr_guest_otp_rate_idx" ON "qr_guest_otp_challenges" (business_id, phone, created_at DESC);
CREATE INDEX IF NOT EXISTS "qr_guest_session_expiry_idx" ON "qr_guest_sessions" (expires_at);
CREATE INDEX IF NOT EXISTS "qr_guest_session_lookup_idx" ON "qr_guest_sessions" (session_token_hash, business_id, menu_token_hash, table_number, phone, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_adjustments_business_name" ON "billing_adjustments" (business_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_customers_business_phone" ON "customers" (business_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_expense_categories_business_name" ON "expense_categories" (business_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_kot_groups_business_name" ON "kot_groups" (business_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_menu_categories_business_name" ON "menu_categories" (business_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_restaurant_tables_business_table_number" ON "restaurant_tables" (business_id, table_number);
