# Salon Manager — Design Notes

This document covers the analysis, data model, architecture, Google Drive plan, security review and open questions behind version 1.

## 1. Requirements analysis

The salon needs one dependable place for customers, visits, billing and reporting that non-technical staff can use on an iPad in seconds. The priorities, in order:

1. **Speed at the counter.** A returning customer is found by phone number and billed in 15–30 seconds. The New Visit screen combines check-in and billing in one page with an on-screen number pad, "Same as last time", big service tiles and one-tap payment methods.
2. **Never lose or rewrite history.** Every visit, invoice and payment is permanent. Prices and tax are copied onto each invoice. Corrections are voids, not deletes.
3. **Data stays under the owner's control.** A single database file on the salon's own computer, with hourly backups to the owner's own Google Drive.
4. **Simple to run.** No server administration: double-click to start on a Mac; the iPad opens it in Safari.

## 2. Architecture

```
iPad (Safari, Home Screen app) ─┐
                                ├─ Wi-Fi ─▶  Salon Mac: Node.js app ──▶ data/salon.db (SQLite)
Mac browser (Safari / Chrome) ──┘                    │                  data/backups/*.db
                                                     └──▶ Google Drive (backups, receipts, reports, exports)
                                                     └──▶ Owner's mailbox via SMTP (email receipts)
```

- **Server:** Node.js 20+ with Express. One process, no build step. `server/app.js` wires everything; each area has a route file in `server/routes/` and logic in `server/lib/`.
- **Database:** SQLite (via `better-sqlite3`) in WAL mode. A real relational database with foreign keys, transactions and indexes, stored in one file that is easy to back up. SQLite comfortably handles hundreds of thousands of visits for a single salon; every search used at the counter is indexed.
- **Browser app:** plain JavaScript modules and CSS (no framework, no build tools), served by the same process. All text is inserted with `textContent`, so customer data can never be interpreted as HTML.
- **Money:** integer cents everywhere. Tax is basis points (13% = 1300). Discounts are spread across lines and tax is calculated once on the taxable total, so the receipt's tax always equals rate × taxable amount, and the lines always add up to the totals.
- **Time:** timestamps are stored in UTC; each visit, invoice and payment also stores its *business date* in the salon's time zone (default America/Toronto), so "today" and monthly reports follow the salon's calendar.
- **Hosting options:** (a) free, on a Mac at the salon (recommended to start), or (b) a small cloud server or container (Dockerfile included, about $5/month) for access from anywhere over HTTPS. The code is the same.

## 3. Database schema

All tables have an integer primary key plus `created_at` and `updated_at` (ISO-8601 UTC). Money columns end in `_cents`.

| Table | Purpose | Key columns |
|---|---|---|
| `roles` | Owner / Staff | `code` unique |
| `users` | Logins | `username` unique, `password_hash` (scrypt), `role_id` → roles, `active` |
| `sessions` | Signed-in devices | `id` = SHA-256 of cookie token, `user_id`, `expires_at` |
| `customers` | Customer database | `customer_code` (CUS-000001, unique, permanent), `full_name`, `phone`, `phone_digits` (indexed lookup key), `email`, `date_of_birth`, `address`, `preferred_services`, `referral_source`, `first_visit_date`, `status` |
| `customer_notes` | General notes about a customer | `customer_id` → customers, `note`, `created_by` |
| `service_categories` | Hair, Facial, … | `name` unique, `sort_order`, `active` |
| `services` | Service menu | `category_id`, `name`, `description`, `price_cents`, `duration_minutes`, `taxable`, `active` |
| `visits` | One row per customer visit | `visit_code` (VIS-000001), `customer_id`, `staff_user_id`, `appointment_id` (future), `visit_at`, `business_date`, `is_first_visit`, `status` (completed/void), `notes` (visit-specific note) |
| `visit_services` | Services performed | `visit_id`, `service_id`, `staff_user_id`, `service_name` + `unit_price_cents` **copied at the time of the visit**, `quantity` |
| `invoices` | One per visit | `invoice_number` (INV-2026-000001), `visit_id` unique, `customer_id`, `subtotal/discount/tax/total/paid/balance_cents`, `tax_name`, `tax_rate_bp`, `prices_include_tax`, `status` (paid/partial/unpaid/void), void reason/by/at |
| `invoice_items` | Receipt lines | `invoice_id`, `item_type` (service/custom), `description`, `quantity`, `unit_price_cents`, `line_subtotal/discount/tax/line_total_cents`, `taxable` |
| `payments` | Money received | `invoice_id`, `customer_id`, `method` (cash/debit/credit/etransfer/other), `amount_cents`, `received_by`, `business_date`, `status` |
| `business_settings` | Key/value settings | business info, tax, receipt text, backup schedule, encrypted credentials |
| `backups` | Backup history | `filename`, `kind` (auto/manual/pre-restore), `size_bytes`, `status`, `drive_status` |
| `audit_logs` | Append-only trail | `user_id`, `username`, `action`, `entity_type`, `entity_id`, `details` (JSON), `ip` |
| `appointments`, `appointment_services` | Ready for the future calendar | `customer_id`, `staff_user_id`, `start_at`, `end_at`, `status`, `reminder_sent_at` |
| `counters` | Sequential ID generator | used inside the same transaction as the insert |

**Guarantees enforced by the database itself** (triggers, independent of the app code):
- `audit_logs` cannot be updated or deleted.
- `invoices`, `payments`, `visits`, `visit_services`, `invoice_items` and `customers` cannot be deleted.
- `invoice_items` and `visit_services` cannot be changed; invoice amounts, number and date cannot be changed. Only status fields (void, paid amount) move.

**Indexes:** `customers(phone_digits)`, `customers(name_search)`, `customers(email)`, `customers.customer_code` (unique), `invoices.invoice_number` (unique), `invoices(business_date)`, `visits(customer_id, visit_at)`, `visits(business_date)`, `payments(business_date)`, plus foreign-key indexes.

**Customer history** is never stored separately: the profile is computed from `visits` + `invoices` + `payments` each time, so it can never drift from the financial records.

## 4. Google Drive: how storage and backup work

**Recommendation: SQLite is the live database; Google Drive holds copies.**

Using Drive (files or Google Sheets) as the *primary* database was considered and rejected:
- Drive has no transactions or row locking. If the iPad and the Mac save at the same moment, one change can silently overwrite the other.
- Every save becomes an internet round trip (slow at the counter, and the salon stops working when the internet drops).
- Google API quotas and token expiry would turn into outages during business hours.
- Sheets cannot enforce the rules above (no duplicate invoice numbers, no editing past invoices).

What the app does with Drive instead:
- The owner connects their Google account once (Settings › Backup & Data). The app asks only for the `drive.file` permission, which lets it see **only the files it creates**, never the rest of the Drive.
- It creates `Beauty Parlour/` with `Backups/`, `Reports/`, `Receipts/` and `Exports/`.
- **Automatic backup** every hour (default; skipped when nothing has been saved since the last one), or once a day after a chosen hour. A consistent snapshot of the database is saved in `data/backups/` and uploaded to `Backups/`.
- **Retention**: every automatic backup from the last 48 hours, then the newest of each day for `backup_keep_local` days (default 30), on the Mac and in Drive. Manual and pre-restore backups are only removed by the owner.
- **Backup Now**, **Export All Data** (Excel workbook), **Save report to Drive** and **Save receipt to Drive** buttons.
- **Restore** from a backup on the Mac, from a file, or straight from Drive (useful if the Mac is lost: install on a new Mac, connect Drive, restore). Every restore first takes a safety copy of the current data so it can be undone. Restores require typing RESTORE.
- The refresh token is stored encrypted (AES-256-GCM) with a key kept in `data/secret.key`, outside the backups.

## 5. Security and privacy

Implemented:
- Owner and staff accounts with role-based permissions checked on the server for every request. Staff can manage customers, check in, bill, record payments and view history; reports, settings, staff accounts, backups, exports, voids, service prices and the audit log are owner-only.
- The sign-in screen is off by default (owner's request): the app opens as the owner for anyone on the salon Wi-Fi. Settings › My Account turns it on with a username and password. The default owner account gets a random, unusable password until then.
- Passwords hashed with scrypt (salted).
- Sessions use a random token in an HttpOnly, SameSite cookie; only its hash is stored. Password changes sign out other devices.
- Sign-in lockout for 5 minutes after 5 wrong passwords.
- CSRF protection (custom request header required on every change) plus a strict Content-Security-Policy, `X-Frame-Options: DENY` and no inline scripts.
- Spreadsheet formula injection is neutralised in CSV exports.
- Audit log of sign-ins, customer changes, invoices, voids, payments, price and tax changes, users, backups, restores and exports. It is read-only, enforced in the database.
- Destructive actions need typed confirmation; there is no "delete all customers" anywhere.

Concerns the owner should know about:
- **Wi-Fi traffic is not encrypted when the app runs on the Mac over plain http.** Use the salon's private, password-protected Wi-Fi (never a guest network). For encrypted access from anywhere, host it with HTTPS (option b above) or use a private network tool such as Tailscale.
- **The Mac holds all customer data.** Turn on FileVault disk encryption, a login password and automatic screen lock.
- **Backup files contain customer data.** They are as sensitive as the app. Google Drive copies are protected by the owner's Google account, so turn on 2-Step Verification.
- **Privacy law (PIPEDA).** Collect only what is needed, and be ready to give customers a copy of their data (the export does this). Version 1 has no "erase a customer" action because financial records must be kept for CRA (6 years); see open questions.

## 6. Gaps in the requirements and the defaults chosen

| Topic | Default in v1 | Worth deciding later |
|---|---|---|
| Refunds | Void the invoice (keeps the record, removes it from totals); hand back money outside the app | Partial refunds as negative payments |
| Paying later | Allowed with explicit confirmation; balance shows on the profile and dashboard, and can be paid from the receipt page | Reminders for balances |
| Tax | One configurable tax (Ontario HST 13% to start), per-service taxable flag, tax-included or tax-excluded pricing | Separate GST + PST lines for other provinces |
| Services | The catalogue starts empty; the owner adds services and prices | |
| Tips | Not included | Add a tip line and staff tip report |
| Gift cards, packages, memberships | Not included (future) | |
| Customer erasure requests | Customers can only be made inactive | Anonymise personal fields while keeping invoices |
| Email receipts | Sent through the owner's own mailbox (Gmail app password) | |
| Cash drawer / card terminal | Payment method is recorded; no hardware integration | |
| Receipt printer | Browser print (AirPrint from iPad) and PDF | 80 mm thermal printer layout |
| Multiple staff on one iPad | Each person signs in; "Served by" can be chosen per visit | Quick PIN switching |
| Time zone | America/Toronto, changeable in Settings | |

## 7. Designed for the future

- **Appointments:** tables already exist and visits carry `appointment_id`; a calendar can be added without changing existing data.
- **Staff commission / reports:** every visit service stores who performed it.
- **Loyalty, memberships, gift cards, packages:** new tables linked to `customers` and `invoices`; invoice lines already support non-service items.
- **SMS / email / WhatsApp reminders and birthday messages:** customers already store phone, email and date of birth; a scheduler exists (used by backups).
- **Multi-location:** add a `locations` table and a `location_id` to visits and invoices.
- **Online booking / customer portal / online payments:** would require cloud hosting with HTTPS (option b).
