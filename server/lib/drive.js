'use strict';

const crypto = require('crypto');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'Beauty Parlour';
const SUBFOLDERS = { backups: 'Backups', reports: 'Reports', receipts: 'Receipts', exports: 'Exports' };
// drive.file only lets the app see files it created itself, never the rest of the owner's Drive.
const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email';

function driveError(message, status = 400) {
  return Object.assign(new Error(message), { status, expose: true });
}

// Google Drive integration using plain HTTPS calls (no SDK) so it is easy to audit.
class DriveService {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.authUrl = opts.authUrl || 'https://accounts.google.com/o/oauth2/v2/auth';
    this.tokenUrl = opts.tokenUrl || 'https://oauth2.googleapis.com/token';
    this.revokeUrl = opts.revokeUrl || 'https://oauth2.googleapis.com/revoke';
    this.apiUrl = opts.apiUrl || 'https://www.googleapis.com/drive/v3';
    this.uploadUrl = opts.uploadUrl || 'https://www.googleapis.com/upload/drive/v3';
    this.fetch = opts.fetch || ((...a) => fetch(...a));
    this.pendingStates = new Map();
    this.accessToken = null;
    this.accessTokenExpires = 0;
    this.foldersVerified = false;
  }

  credentials() {
    const s = this.ctx.settings;
    return {
      clientId: process.env.GOOGLE_CLIENT_ID || s.get('drive_client_id'),
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || s.get('drive_client_secret'),
    };
  }

  isConfigured() {
    const c = this.credentials();
    return !!(c.clientId && c.clientSecret);
  }

  isConnected() {
    return this.isConfigured() && !!this.ctx.settings.get('drive_refresh_token');
  }

  status() {
    return {
      configured: this.isConfigured(),
      connected: this.isConnected(),
      account: this.ctx.settings.get('drive_account_email') || null,
      connectedAt: this.ctx.settings.get('drive_connected_at') || null,
      envCredentials: !!process.env.GOOGLE_CLIENT_ID,
    };
  }

  beginAuth(userId, redirectUri) {
    if (!this.isConfigured()) throw driveError('Add your Google OAuth client ID and secret first.');
    const state = crypto.randomBytes(24).toString('base64url');
    this.pendingStates.set(state, { userId, redirectUri, expires: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: this.credentials().clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${this.authUrl}?${params}`;
  }

  async completeAuth(state, code) {
    const pending = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (!pending || pending.expires < Date.now()) throw driveError('The Google sign-in link expired. Please try connecting again.');
    const { clientId, clientSecret } = this.credentials();
    const res = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: pending.redirectUri, grant_type: 'authorization_code' }),
    });
    const tok = await res.json();
    if (!res.ok || !tok.refresh_token) throw driveError('Google did not grant access: ' + (tok.error_description || tok.error || 'no refresh token'));
    let email = null;
    if (tok.id_token) {
      try {
        email = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8')).email || null;
      } catch {
        /* ignore */
      }
    }
    const s = this.ctx.settings;
    s.set('drive_refresh_token', tok.refresh_token, pending.userId);
    s.set('drive_account_email', email || '', pending.userId);
    s.set('drive_connected_at', new Date().toISOString(), pending.userId);
    s.set('drive_folders', '', pending.userId);
    this.accessToken = tok.access_token;
    this.accessTokenExpires = Date.now() + (Number(tok.expires_in || 3600) - 60) * 1000;
    this.foldersVerified = false;
    await this.ensureFolders();
    return { userId: pending.userId, email };
  }

  async disconnect(userId) {
    const token = this.ctx.settings.get('drive_refresh_token');
    if (token) {
      try {
        await this.fetch(this.revokeUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
      } catch {
        /* revocation is best effort */
      }
    }
    const s = this.ctx.settings;
    for (const k of ['drive_refresh_token', 'drive_account_email', 'drive_connected_at', 'drive_folders']) s.set(k, '', userId);
    this.accessToken = null;
    this.foldersVerified = false;
  }

  async token() {
    if (!this.isConnected()) throw driveError('Google Drive is not connected. The owner can connect it in Settings > Backup.');
    if (this.accessToken && Date.now() < this.accessTokenExpires) return this.accessToken;
    const { clientId, clientSecret } = this.credentials();
    const res = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: this.ctx.settings.get('drive_refresh_token'), grant_type: 'refresh_token' }),
    });
    const tok = await res.json();
    if (!res.ok) throw driveError('Google Drive access has expired or was removed. Please reconnect Google Drive. (' + (tok.error || res.status) + ')', 502);
    this.accessToken = tok.access_token;
    this.accessTokenExpires = Date.now() + (Number(tok.expires_in || 3600) - 60) * 1000;
    return this.accessToken;
  }

  async api(method, url, { json, headers = {}, raw } = {}) {
    const token = await this.token();
    const res = await this.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : raw,
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error?.message || '';
      } catch {
        /* ignore */
      }
      throw driveError(`Google Drive request failed (${res.status}) ${detail}`.trim(), 502);
    }
    return res;
  }

  async findOrCreateFolder(name, parentId) {
    const q = [`name = '${name.replace(/'/g, "\\'")}'`, `mimeType = '${FOLDER_MIME}'`, 'trashed = false', parentId ? `'${parentId}' in parents` : "'root' in parents"].join(' and ');
    const list = await (await this.api('GET', `${this.apiUrl}/files?${new URLSearchParams({ q, fields: 'files(id,name)', spaces: 'drive' })}`)).json();
    if (list.files && list.files.length) return list.files[0].id;
    const created = await (await this.api('POST', `${this.apiUrl}/files?fields=id`, { json: { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) } })).json();
    return created.id;
  }

  // Creates "Beauty Parlour/{Backups,Reports,Receipts,Exports}" once and remembers the IDs.
  async ensureFolders() {
    const s = this.ctx.settings;
    let folders = {};
    try {
      folders = JSON.parse(s.get('drive_folders') || '{}');
    } catch {
      folders = {};
    }
    if (this.foldersVerified && folders.root) return folders;
    let rootOk = false;
    if (folders.root) {
      try {
        const meta = await (await this.api('GET', `${this.apiUrl}/files/${encodeURIComponent(folders.root)}?fields=id,trashed`)).json();
        rootOk = !meta.trashed;
      } catch {
        rootOk = false;
      }
    }
    if (!rootOk) folders = { root: await this.findOrCreateFolder(ROOT_NAME, null) };
    for (const [key, name] of Object.entries(SUBFOLDERS)) {
      if (!folders[key] || !rootOk) folders[key] = await this.findOrCreateFolder(name, folders.root);
    }
    s.set('drive_folders', JSON.stringify(folders));
    this.foldersVerified = true;
    return folders;
  }

  async upload(folderKey, name, mimeType, buffer) {
    const folders = await this.ensureFolders();
    const init = await this.api('POST', `${this.uploadUrl}/files?uploadType=resumable&fields=id,name`, {
      json: { name, parents: [folders[folderKey]] },
      headers: { 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(buffer.length) },
    });
    const location = init.headers.get('location');
    if (!location) throw driveError('Google Drive did not accept the upload', 502);
    const res = await this.fetch(location, { method: 'PUT', headers: { 'Content-Type': mimeType, 'Content-Length': String(buffer.length) }, body: buffer });
    if (!res.ok) throw driveError(`Google Drive upload failed (${res.status})`, 502);
    return res.json();
  }

  async listBackups() {
    const folders = await this.ensureFolders();
    const q = `'${folders.backups}' in parents and trashed = false`;
    const res = await this.api('GET', `${this.apiUrl}/files?${new URLSearchParams({ q, orderBy: 'createdTime desc', pageSize: '100', fields: 'files(id,name,size,createdTime)' })}`);
    return (await res.json()).files || [];
  }

  async deleteFile(fileId) {
    if (!/^[\w-]+$/.test(fileId)) throw driveError('Invalid file');
    await this.api('DELETE', `${this.apiUrl}/files/${fileId}`);
  }

  async download(fileId) {
    if (!/^[\w-]+$/.test(fileId)) throw driveError('Invalid file');
    const res = await this.api('GET', `${this.apiUrl}/files/${fileId}?alt=media`);
    return Buffer.from(await res.arrayBuffer());
  }
}

module.exports = { DriveService, SUBFOLDERS, ROOT_NAME };
