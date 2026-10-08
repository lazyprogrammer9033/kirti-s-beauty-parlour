'use strict';

const fs = require('fs');
const path = require('path');
const { validateBackupFile } = require('../db');
const { nowIso, businessDate, localHour } = require('./time');
const { audit } = require('./audit');

const HOUR = 60 * 60 * 1000;

// Backups are consistent SQLite snapshots made with SQLite's online backup API,
// so they are safe to take while the salon is using the app.
class BackupService {
  constructor(ctx) {
    this.ctx = ctx;
    this.dir = path.join(ctx.dataDir, 'backups');
    this.timer = null;
    this.running = false;
  }

  stamp() {
    const tz = this.ctx.settings.timezone();
    const now = new Date();
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now).replace(/:/g, '');
    return `${businessDate(now, tz)}_${time}`;
  }

  filePath(filename) {
    const safe = path.basename(filename);
    if (safe !== filename || !/^salon-backup-[\w.-]+\.db$/.test(safe)) throw Object.assign(new Error('Invalid backup name'), { status: 400, expose: true });
    return path.join(this.dir, safe);
  }

  async create(kind, req) {
    if (this.running) throw Object.assign(new Error('A backup is already running. Please wait a moment.'), { status: 409, expose: true });
    this.running = true;
    const db = this.ctx.db();
    fs.mkdirSync(this.dir, { recursive: true });
    const filename = `salon-backup-${this.stamp()}-${kind}.db`;
    const file = path.join(this.dir, filename);
    const now = nowIso();
    let record;
    try {
      await db.backup(file);
      const size = fs.statSync(file).size;
      let driveStatus = 'skipped';
      let driveFileId = null;
      let error = null;
      if (this.ctx.drive.isConnected()) {
        try {
          const up = await this.ctx.drive.upload('backups', filename, 'application/x-sqlite3', fs.readFileSync(file));
          driveStatus = 'uploaded';
          driveFileId = up.id;
        } catch (e) {
          driveStatus = 'failed';
          error = 'Saved on this computer, but Google Drive upload failed: ' + e.message;
        }
      }
      const id = db.prepare(`INSERT INTO backups (filename, kind, size_bytes, status, drive_status, drive_file_id, error, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'success', ?, ?, ?, ?, ?, ?)`).run(filename, kind, size, driveStatus, driveFileId, error, req?.user?.id || null, now, now).lastInsertRowid;
      audit(db, req || null, 'backup.created', 'backup', id, { filename, kind, driveStatus });
      record = this.get(id);
      await this.prune().catch((e) => console.error('Backup cleanup failed:', e.message));
    } catch (e) {
      db.prepare(`INSERT INTO backups (filename, kind, status, error, created_by, created_at, updated_at) VALUES (?, ?, 'failed', ?, ?, ?, ?)`)
        .run(filename, kind, e.message, req?.user?.id || null, now, now);
      throw e;
    } finally {
      this.running = false;
    }
    return record;
  }

  get(id) {
    return this.ctx.db().prepare(`SELECT id, filename, kind, size_bytes AS sizeBytes, status, drive_status AS driveStatus, error, created_at AS createdAt
      FROM backups WHERE id = ?`).get(id);
  }

  list() {
    const rows = this.ctx.db().prepare(`SELECT id, filename, kind, size_bytes AS sizeBytes, status, drive_status AS driveStatus, error, created_at AS createdAt
      FROM backups ORDER BY id DESC LIMIT 100`).all();
    for (const r of rows) r.onDisk = r.status === 'success' && fs.existsSync(path.join(this.dir, r.filename));
    return rows;
  }

  status() {
    const db = this.ctx.db();
    const last = db.prepare("SELECT created_at AS at, filename, drive_status AS driveStatus FROM backups WHERE status = 'success' ORDER BY id DESC LIMIT 1").get();
    const lastFailure = db.prepare("SELECT created_at AS at, error FROM backups WHERE status = 'failed' OR drive_status = 'failed' ORDER BY id DESC LIMIT 1").get();
    const s = this.ctx.settings;
    return {
      lastSuccess: last || null,
      lastFailure: lastFailure && (!last || lastFailure.at >= last.at) ? lastFailure : null,
      autoEnabled: s.get('backup_auto_enabled') === '1',
      frequency: s.get('backup_frequency') === 'daily' ? 'daily' : 'hourly',
      backupHour: Number(s.get('backup_hour') || 22),
      keepLocal: Number(s.get('backup_keep_local') || 30),
      folder: this.dir,
    };
  }

  // Automatic backups: every one from the last 48 hours, then the newest of each
  // day for backup_keep_local days. Older ones are removed from this computer
  // and from Google Drive. Manual and pre-restore backups are only removed by the owner.
  async prune() {
    const db = this.ctx.db();
    const tz = this.ctx.settings.timezone();
    const days = Math.max(Number(this.ctx.settings.get('backup_keep_local') || 30), 3);
    const now = Date.now();
    const autos = db.prepare("SELECT id, filename, drive_file_id AS driveFileId, created_at AS createdAt FROM backups WHERE kind = 'auto' AND status = 'success' ORDER BY id DESC").all();
    const seenDays = new Set();
    const remove = [];
    for (const r of autos) {
      const age = now - new Date(r.createdAt).getTime();
      const day = businessDate(new Date(r.createdAt), tz);
      const keep = age < 48 * HOUR || (!seenDays.has(day) && age < days * 24 * HOUR);
      seenDays.add(day);
      if (!keep) remove.push(r);
    }
    for (const r of remove) {
      try {
        fs.rmSync(path.join(this.dir, r.filename), { force: true });
      } catch {
        /* ignore */
      }
    }
    if (!this.ctx.drive.isConnected()) return;
    for (const r of remove.filter((x) => x.driveFileId)) {
      try {
        await this.ctx.drive.deleteFile(r.driveFileId);
        db.prepare('UPDATE backups SET drive_file_id = NULL, updated_at = ? WHERE id = ?').run(nowIso(), r.id);
      } catch (e) {
        console.error('Could not remove an old backup from Google Drive:', e.message);
      }
    }
  }

  // Hourly backups are skipped when nothing has been saved since the last one,
  // so a closed salon does not fill Google Drive with identical copies.
  dataChanges() {
    return this.ctx.db().prepare('SELECT total_changes() AS n').get().n;
  }

  async maybeRunScheduled() {
    const s = this.ctx.settings;
    if (s.get('backup_auto_enabled') !== '1') return null;
    const tz = s.timezone();
    const now = new Date();
    const done = this.ctx.db().prepare("SELECT created_at FROM backups WHERE kind = 'auto' AND status = 'success' ORDER BY id DESC LIMIT 1").get();
    if (s.get('backup_frequency') === 'daily') {
      if (localHour(now, tz) < Number(s.get('backup_hour') || 22)) return null;
      if (done && businessDate(new Date(done.created_at), tz) === businessDate(now, tz)) return null;
    } else {
      if (done && now - new Date(done.created_at) < HOUR - 5 * 60 * 1000) return null;
      if (done && this.changesAtLastAuto === this.dataChanges()) return null;
    }
    const record = await this.create('auto', null);
    this.changesAtLastAuto = this.dataChanges();
    return record;
  }

  startScheduler() {
    const tick = () => this.maybeRunScheduled().catch((e) => console.error('Automatic backup failed:', e.message));
    this.timer = setInterval(tick, 10 * 60 * 1000);
    this.timer.unref();
    setTimeout(tick, 30 * 1000).unref();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
  }

  // Replaces the live database with a backup. A safety backup of the current
  // data is always taken first so a restore can itself be undone.
  async restoreFromFile(sourceFile, req, label) {
    const check = validateBackupFile(sourceFile);
    if (!check.ok) throw Object.assign(new Error(check.error), { status: 400, expose: true });
    const safety = await this.create('pre-restore', req);
    // Backup history lives in the database too; carry it over so the list of
    // backup files stays complete after going back to an older snapshot.
    const history = this.ctx.db().prepare('SELECT * FROM backups ORDER BY id').all();
    const holder = this.ctx.holder;
    const target = holder.file;
    const staged = target + '.restoring';
    fs.copyFileSync(sourceFile, staged);
    holder.close();
    try {
      for (const ext of ['-wal', '-shm']) fs.rmSync(target + ext, { force: true });
      fs.renameSync(staged, target);
    } finally {
      holder.open();
    }
    const restoredDb0 = this.ctx.db();
    const has = restoredDb0.prepare('SELECT 1 FROM backups WHERE filename = ?');
    const withId = restoredDb0.prepare(`INSERT OR IGNORE INTO backups (id, filename, kind, size_bytes, status, drive_status, drive_file_id, error, created_by, created_at, updated_at)
      VALUES (@id, @filename, @kind, @size_bytes, @status, @drive_status, @drive_file_id, @error, NULL, @created_at, @updated_at)`);
    const noId = restoredDb0.prepare(`INSERT INTO backups (filename, kind, size_bytes, status, drive_status, drive_file_id, error, created_by, created_at, updated_at)
      VALUES (@filename, @kind, @size_bytes, @status, @drive_status, @drive_file_id, @error, NULL, @created_at, @updated_at)`);
    restoredDb0.transaction(() => {
      for (const row of history) {
        if (has.get(row.filename)) continue;
        if (withId.run(row).changes === 0) noId.run(row);
      }
    })();
    // Record the restore in the restored database's own audit log. The signed-in
    // user may not exist in the restored data, so only link them when they do.
    const restoredDb = this.ctx.db();
    const userId = req?.user?.id;
    const known = userId && restoredDb.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
    const auditReq = { ip: req?.ip, user: known ? req.user : null };
    audit(restoredDb, auditReq, 'backup.restored', 'backup', null, { from: label, safetyBackup: safety.filename, ...check.counts });
    return { restored: label, safetyBackup: safety.filename, counts: check.counts };
  }
}

module.exports = { BackupService };
