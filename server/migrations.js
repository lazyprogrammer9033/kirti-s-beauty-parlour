'use strict';

// Schema migrations. Each entry runs once, in order, inside a transaction.
// Never edit a migration that has shipped; add a new one instead.
//
// Conventions:
// - Money is stored as INTEGER cents (CAD) to avoid floating point errors.
// - Timestamps are ISO-8601 UTC strings (created_at / updated_at on every table).
// - business_date columns hold the salon's local calendar date (YYYY-MM-DD) so
//   reports group by the day the salon experienced, not the UTC day.
// - Financial records (visits, invoices, payments) are never deleted: they are voided.

module.exports = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE roles (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,           -- 'owner' | 'staff'
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                  -- sha256 of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  customer_code TEXT NOT NULL UNIQUE,   -- CUS-000001, permanent
  full_name TEXT NOT NULL,
  name_search TEXT NOT NULL,            -- lower-cased name for search
  phone TEXT NOT NULL,                  -- as displayed
  phone_digits TEXT NOT NULL,           -- normalised digits for lookup
  email TEXT,
  date_of_birth TEXT,
  address TEXT,
  preferred_services TEXT,
  referral_source TEXT,
  first_visit_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customers_phone ON customers(phone_digits);
CREATE INDEX idx_customers_name ON customers(name_search);
CREATE INDEX idx_customers_email ON customers(email COLLATE NOCASE);
CREATE INDEX idx_customers_status ON customers(status);

-- General notes about a customer (visit-specific notes live on visits.notes).
CREATE TABLE customer_notes (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  note TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customer_notes_customer ON customer_notes(customer_id);

CREATE TABLE service_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE services (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES service_categories(id),
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  duration_minutes INTEGER,
  taxable INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_services_category ON services(category_id);

-- Designed now, used by a future appointments screen.
CREATE TABLE appointments (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  staff_user_id INTEGER REFERENCES users(id),
  start_at TEXT NOT NULL,
  end_at TEXT,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','confirmed','completed','cancelled','no_show')),
  notes TEXT,
  reminder_sent_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_appointments_start ON appointments(start_at);
CREATE INDEX idx_appointments_customer ON appointments(customer_id);

CREATE TABLE appointment_services (
  id INTEGER PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE visits (
  id INTEGER PRIMARY KEY,
  visit_code TEXT NOT NULL UNIQUE,      -- VIS-000001, permanent
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  staff_user_id INTEGER REFERENCES users(id),
  appointment_id INTEGER REFERENCES appointments(id),
  visit_at TEXT NOT NULL,
  business_date TEXT NOT NULL,
  is_first_visit INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','void')),
  notes TEXT,                           -- visit-specific note
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_visits_customer ON visits(customer_id, visit_at);
CREATE INDEX idx_visits_date ON visits(business_date);

-- Services performed, with the price as it was on the day.
CREATE TABLE visit_services (
  id INTEGER PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  service_id INTEGER REFERENCES services(id),
  staff_user_id INTEGER REFERENCES users(id),
  service_name TEXT NOT NULL,
  category_name TEXT,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_visit_services_visit ON visit_services(visit_id);
CREATE INDEX idx_visit_services_service ON visit_services(service_id);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,  -- INV-2026-000001, permanent
  visit_id INTEGER NOT NULL UNIQUE REFERENCES visits(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  issued_at TEXT NOT NULL,
  business_date TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  subtotal_cents INTEGER NOT NULL,
  discount_type TEXT CHECK (discount_type IN ('amount','percent')),
  discount_value INTEGER,               -- cents, or basis points for percent
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_name TEXT NOT NULL,
  tax_rate_bp INTEGER NOT NULL,         -- 1300 = 13.00%
  prices_include_tax INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('paid','partial','unpaid','void')),
  void_reason TEXT,
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_invoices_date ON invoices(business_date);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status ON invoices(status);

CREATE TABLE invoice_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  visit_service_id INTEGER REFERENCES visit_services(id),
  service_id INTEGER REFERENCES services(id),
  item_type TEXT NOT NULL DEFAULT 'service' CHECK (item_type IN ('service','custom')),
  description TEXT NOT NULL,
  category_name TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  line_subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_service ON invoice_items(service_id);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  method TEXT NOT NULL CHECK (method IN ('cash','debit','credit','etransfer','other')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reference TEXT,
  received_at TEXT NOT NULL,
  business_date TEXT NOT NULL,
  received_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','void')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);
CREATE INDEX idx_payments_date ON payments(business_date);

CREATE TABLE business_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE backups (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','manual','pre-restore')),
  size_bytes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('success','failed')),
  drive_status TEXT CHECK (drive_status IN ('uploaded','failed','skipped')),
  drive_file_id TEXT,
  error TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  username TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

-- Database-level guarantees, independent of application code.
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices
BEGIN SELECT RAISE(ABORT, 'invoices cannot be deleted; void them instead'); END;
CREATE TRIGGER invoice_items_no_delete BEFORE DELETE ON invoice_items
BEGIN SELECT RAISE(ABORT, 'invoice items cannot be deleted'); END;
CREATE TRIGGER invoice_items_no_update BEFORE UPDATE ON invoice_items
BEGIN SELECT RAISE(ABORT, 'invoice items are immutable'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'payments cannot be deleted; void them instead'); END;
CREATE TRIGGER visits_no_delete BEFORE DELETE ON visits
BEGIN SELECT RAISE(ABORT, 'visits cannot be deleted; void them instead'); END;
CREATE TRIGGER visit_services_no_delete BEFORE DELETE ON visit_services
BEGIN SELECT RAISE(ABORT, 'visit services cannot be deleted'); END;
CREATE TRIGGER visit_services_no_update BEFORE UPDATE ON visit_services
BEGIN SELECT RAISE(ABORT, 'visit services are immutable'); END;
CREATE TRIGGER invoices_amounts_immutable BEFORE UPDATE OF
  subtotal_cents, discount_cents, tax_cents, tax_rate_bp, total_cents, invoice_number, issued_at ON invoices
BEGIN SELECT RAISE(ABORT, 'invoice amounts are immutable'); END;
CREATE TRIGGER customers_no_delete BEFORE DELETE ON customers
BEGIN SELECT RAISE(ABORT, 'customers cannot be deleted; mark them inactive'); END;
`,
  },
  {
    id: 2,
    name: 'offline sync references',
    // client_ref is a random id the iPad gives a customer or visit it saved
    // while offline, so sending it again after a dropped connection is harmless.
    sql: `
ALTER TABLE customers ADD COLUMN client_ref TEXT;
ALTER TABLE visits ADD COLUMN client_ref TEXT;
CREATE UNIQUE INDEX customers_client_ref ON customers(client_ref) WHERE client_ref IS NOT NULL;
CREATE UNIQUE INDEX visits_client_ref ON visits(client_ref) WHERE client_ref IS NOT NULL;
`,
  },
];
