'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp } = require('./helpers');

const autoCount = (db) => db.prepare("SELECT COUNT(*) c FROM backups WHERE kind = 'auto' AND status = 'success'").get().c;

test('hourly is the default and skips when nothing changed or under an hour passed', async () => {
  const t = await startApp();
  try {
    const { backups, settings } = t.ctx;
    const db = t.ctx.db();
    assert.equal(settings.get('backup_frequency'), 'hourly');
    assert.ok(await backups.maybeRunScheduled());
    assert.equal(await backups.maybeRunScheduled(), null, 'less than an hour since the last one');

    const ago = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    db.prepare("UPDATE backups SET created_at = ? WHERE kind = 'auto'").run(ago);
    backups.changesAtLastAuto = backups.dataChanges();
    assert.equal(await backups.maybeRunScheduled(), null, 'nothing changed since the last one');

    db.prepare("INSERT INTO customers (customer_code, full_name, phone, phone_digits, name_search, status, created_at, updated_at) VALUES ('CUS-T1', 'A', '4165550111', '4165550111', 'a', 'active', ?, ?)").run(ago, ago);
    assert.ok(await backups.maybeRunScheduled());
    assert.equal(autoCount(db), 2);
  } finally {
    await t.close();
  }
});

test('pruning keeps 48 hours of hourly backups, then one per day', async () => {
  const t = await startApp();
  try {
    const { backups } = t.ctx;
    const db = t.ctx.db();
    fs.mkdirSync(backups.dir, { recursive: true });
    const ins = db.prepare("INSERT INTO backups (filename, kind, size_bytes, status, created_at, updated_at) VALUES (?, 'auto', 1, 'success', ?, ?)");
    const names = [];
    // Three backups a day, 5 hours apart, for 40 days.
    for (let d = 40; d >= 0; d--) {
      for (const hr of [10, 15, 20]) {
        const at = new Date(Date.now() - d * 86400000 - hr * 3600000).toISOString();
        const name = `salon-backup-t${d}-${hr}-auto.db`;
        fs.writeFileSync(path.join(backups.dir, name), 'x');
        ins.run(name, at, at);
        names.push(name);
      }
    }
    await backups.prune();
    const left = names.filter((n) => fs.existsSync(path.join(backups.dir, n)));
    // About 2 days x 3 kept whole, plus one per day for the rest of the 30 days.
    assert.ok(left.length >= 32 && left.length <= 36, `kept ${left.length}`);
    assert.ok(!left.includes('salon-backup-t35-10-auto.db'));
    assert.ok(left.includes('salon-backup-t0-20-auto.db'));
  } finally {
    await t.close();
  }
});
