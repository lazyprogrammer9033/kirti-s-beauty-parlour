'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// A private certificate authority made on this computer, so the iPad can reach
// the app over https (which Safari requires before it keeps the app for
// offline use). The iPad trusts it once; the server certificate is re-issued
// from it whenever this computer's name or Wi-Fi address changes.

const SERVER_DAYS = 800; // Apple accepts at most 825 days for server certificates.

function localNames() {
  const host = os.hostname().replace(/\.local$/i, '');
  const dns = [...new Set(['localhost', host, `${host}.local`])];
  const ips = ['127.0.0.1', ...Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address)];
  return { dns, ips: [...new Set(ips)] };
}

function openssl(args, cwd) {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

function needsNewServerCert(certFile, names) {
  if (!fs.existsSync(certFile)) return true;
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certFile));
    if (new Date(cert.validTo).getTime() - Date.now() < 30 * 24 * 3600 * 1000) return true;
    const san = cert.subjectAltName || '';
    return !names.dns.every((d) => san.includes(`DNS:${d}`)) || !names.ips.every((ip) => san.includes(`IP Address:${ip}`));
  } catch {
    return true;
  }
}

// Returns { key, cert, caFile } for https.createServer, or null when openssl is unavailable.
function ensureCertificates(dataDir) {
  const dir = path.join(dataDir, 'https');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = (n) => path.join(dir, n);
  const names = localNames();
  try {
    fs.writeFileSync(f('openssl.cnf'), [
      '[req]', 'distinguished_name = dn', 'prompt = no', '[dn]', 'CN = Salon Manager', '',
      '[v3_ca]', 'basicConstraints = critical, CA:TRUE', 'keyUsage = critical, keyCertSign, cRLSign', 'subjectKeyIdentifier = hash', '',
      '[v3_srv]', 'basicConstraints = CA:FALSE', 'keyUsage = critical, digitalSignature, keyEncipherment', 'extendedKeyUsage = serverAuth',
      'subjectAltName = ' + [...names.dns.map((d) => 'DNS:' + d), ...names.ips.map((ip) => 'IP:' + ip)].join(', '), '',
    ].join('\n'));
    if (!fs.existsSync(f('ca.crt')) || !fs.existsSync(f('ca.key'))) {
      openssl(['genrsa', '-out', 'ca.key', '2048'], dir);
      openssl(['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '3650', '-subj', `/CN=Salon Manager (${os.hostname()})`,
        '-config', 'openssl.cnf', '-extensions', 'v3_ca', '-out', 'ca.crt'], dir);
    }
    if (needsNewServerCert(f('server.crt'), names)) {
      openssl(['genrsa', '-out', 'server.key', '2048'], dir);
      openssl(['req', '-new', '-key', 'server.key', '-subj', `/CN=${names.dns[2] || 'localhost'}`, '-config', 'openssl.cnf', '-out', 'server.csr'], dir);
      openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', '0x' + crypto.randomBytes(12).toString('hex'),
        '-days', String(SERVER_DAYS), '-sha256', '-extfile', 'openssl.cnf', '-extensions', 'v3_srv', '-out', 'server.crt'], dir);
      fs.rmSync(f('server.csr'), { force: true });
    }
    for (const k of ['ca.key', 'server.key']) fs.chmodSync(f(k), 0o600);
    return { key: fs.readFileSync(f('server.key')), cert: fs.readFileSync(f('server.crt')), caFile: f('ca.crt') };
  } catch (e) {
    console.warn('  Secure (https) access is off: ' + (e.code === 'ENOENT' ? 'openssl was not found' : e.message.split('\n')[0]));
    return null;
  }
}

module.exports = { ensureCertificates, localNames };
