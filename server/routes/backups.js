'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { requirePerm, HttpError, intParam } = require('../lib/http');
const { audit } = require('../lib/audit');

const CONFIRM_WORD = 'RESTORE';

module.exports = function backupRoutes(api, ctx) {
  const owner = requirePerm('backups.manage');

  api.get('/backups', owner, (req, res) => {
    res.json({ status: ctx.backups.status(), drive: ctx.drive.status(), backups: ctx.backups.list() });
  });

  api.post('/backups', owner, async (req, res) => {
    res.status(201).json(await ctx.backups.create('manual', req));
  });

  api.get('/backups/:id/download', owner, (req, res) => {
    const b = ctx.backups.get(intParam(req.params.id));
    if (!b || b.status !== 'success') throw new HttpError(404, 'Backup not found');
    const file = ctx.backups.filePath(b.filename);
    if (!fs.existsSync(file)) throw new HttpError(404, 'This backup file is no longer on this computer');
    audit(ctx.db(), req, 'backup.downloaded', 'backup', b.id, { filename: b.filename });
    res.download(file, b.filename);
  });

  // Deleting a backup file needs the owner and an explicit confirmation.
  api.post('/backups/:id/delete', owner, (req, res) => {
    if (req.body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
    const b = ctx.backups.get(intParam(req.params.id));
    if (!b) throw new HttpError(404, 'Backup not found');
    const last = ctx.db().prepare("SELECT id FROM backups WHERE status = 'success' ORDER BY id DESC LIMIT 1").get();
    if (last && last.id === b.id) throw new HttpError(400, 'The most recent backup cannot be deleted');
    fs.rmSync(ctx.backups.filePath(b.filename), { force: true });
    audit(ctx.db(), req, 'backup.deleted', 'backup', b.id, { filename: b.filename });
    res.json({ ok: true });
  });

  const requireConfirm = (req) => {
    const word = req.body?.confirm ?? req.get('X-Confirm');
    if (word !== CONFIRM_WORD) throw new HttpError(400, `Type ${CONFIRM_WORD} to confirm`);
  };

  api.post('/backups/:id/restore', owner, async (req, res) => {
    requireConfirm(req);
    const b = ctx.backups.get(intParam(req.params.id));
    if (!b || b.status !== 'success') throw new HttpError(404, 'Backup not found');
    const file = ctx.backups.filePath(b.filename);
    if (!fs.existsSync(file)) throw new HttpError(404, 'This backup file is no longer on this computer');
    const tmp = path.join(os.tmpdir(), `salon-restore-${Date.now()}.db`);
    fs.copyFileSync(file, tmp);
    try {
      res.json(await ctx.backups.restoreFromFile(tmp, req, b.filename));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  api.post('/backups/restore-upload', owner, express.raw({ type: '*/*', limit: '1gb' }), async (req, res) => {
    requireConfirm(req);
    if (!Buffer.isBuffer(req.body) || req.body.length < 512) throw new HttpError(400, 'Please choose a backup file');
    const tmp = path.join(os.tmpdir(), `salon-upload-${Date.now()}.db`);
    fs.writeFileSync(tmp, req.body);
    try {
      res.json(await ctx.backups.restoreFromFile(tmp, req, 'uploaded file ' + String(req.get('X-Filename') || '').slice(0, 100)));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  api.get('/drive/backups', owner, async (req, res) => {
    res.json(await ctx.drive.listBackups());
  });

  api.post('/drive/backups/:fileId/restore', owner, async (req, res) => {
    requireConfirm(req);
    const buf = await ctx.drive.download(req.params.fileId);
    const tmp = path.join(os.tmpdir(), `salon-drive-${Date.now()}.db`);
    fs.writeFileSync(tmp, buf);
    try {
      res.json(await ctx.backups.restoreFromFile(tmp, req, 'Google Drive file ' + req.params.fileId));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
};
