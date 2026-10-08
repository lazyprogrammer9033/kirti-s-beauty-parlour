'use strict';

const nodemailer = require('nodemailer');

// Sends email through the salon's own mailbox (e.g. Gmail with an app password)
// configured in Settings > Email. Tests pass a fake transport.
class Mailer {
  constructor(ctx, transportOverride) {
    this.ctx = ctx;
    this.transportOverride = transportOverride;
  }

  configured() {
    const s = this.ctx.settings;
    return !!(this.transportOverride || (s.get('smtp_host') && s.get('smtp_user') && s.get('smtp_pass')));
  }

  transport() {
    if (this.transportOverride) return this.transportOverride;
    const s = this.ctx.settings;
    const port = Number(s.get('smtp_port') || 587);
    return nodemailer.createTransport({
      host: s.get('smtp_host'),
      port,
      secure: port === 465,
      auth: { user: s.get('smtp_user'), pass: s.get('smtp_pass') },
    });
  }

  async send({ to, subject, text, html, replyTo, attachments }) {
    if (!this.configured()) {
      const e = new Error('Email is not set up yet. The owner can set it up in Settings > Email.');
      e.status = 400;
      e.expose = true;
      throw e;
    }
    const s = this.ctx.settings;
    const name = s.get('business_name') || 'Beauty Parlour';
    const fromAddr = s.get('smtp_from') || s.get('smtp_user');
    return this.transport().sendMail({ from: `"${name.replace(/"/g, '')}" <${fromAddr}>`, to, replyTo, subject, text, html, attachments });
  }
}

module.exports = { Mailer };
