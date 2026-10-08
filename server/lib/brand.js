'use strict';

const fs = require('fs');
const path = require('path');

// The salon's logo mark (public/img/logo-mark.png), used on receipts, emails
// and the customer page whenever no logo has been uploaded in Settings.
let cached;
function defaultLogo() {
  if (cached === undefined) {
    try {
      cached = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'logo-mark.png')).toString('base64');
    } catch {
      cached = '';
    }
  }
  return cached;
}

module.exports = { defaultLogo };
