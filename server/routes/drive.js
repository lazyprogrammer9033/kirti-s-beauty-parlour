'use strict';

const { requirePerm, HttpError } = require('../lib/http');
const { can } = require('../lib/auth');
const { audit } = require('../lib/audit');

function redirectUri(ctx, req) {
  const base = (ctx.settings.get('app_base_url') || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/api/drive/callback`;
}

// Google sends the owner's browser back here after they approve access.
function publicRoutes(api, ctx) {
  api.get('/drive/callback', async (req, res) => {
    const back = (status, msg) => res.redirect(`/#/settings/backup?drive=${status}${msg ? '&message=' + encodeURIComponent(msg) : ''}`);
    if (!req.user || !can(req.user, 'backups.manage')) return back('error', 'Please sign in as the owner and try again.');
    if (req.query.error) return back('error', 'Google access was not granted.');
    try {
      const out = await ctx.drive.completeAuth(String(req.query.state || ''), String(req.query.code || ''));
      audit(ctx.db(), req, 'drive.connected', 'settings', 'drive', { account: out.email });
      back('connected');
    } catch (e) {
      back('error', e.message);
    }
  });
}

function privateRoutes(api, ctx) {
  const owner = requirePerm('backups.manage');

  api.get('/drive/status', owner, (req, res) => {
    res.json({ ...ctx.drive.status(), redirectUri: redirectUri(ctx, req) });
  });

  api.post('/drive/credentials', owner, (req, res) => {
    const clientId = String(req.body.clientId || '').trim();
    const clientSecret = String(req.body.clientSecret || '').trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new HttpError(400, 'That does not look like a Google OAuth client ID');
    if (!clientSecret) throw new HttpError(400, 'Client secret is required');
    ctx.settings.set('drive_client_id', clientId, req.user.id);
    ctx.settings.set('drive_client_secret', clientSecret, req.user.id);
    audit(ctx.db(), req, 'drive.credentials_updated', 'settings', 'drive');
    res.json({ ok: true });
  });

  api.post('/drive/connect', owner, (req, res) => {
    res.json({ url: ctx.drive.beginAuth(req.user.id, redirectUri(ctx, req)) });
  });

  api.post('/drive/disconnect', owner, async (req, res) => {
    await ctx.drive.disconnect(req.user.id);
    audit(ctx.db(), req, 'drive.disconnected', 'settings', 'drive');
    res.json({ ok: true });
  });
}

module.exports = { publicRoutes, privateRoutes };
