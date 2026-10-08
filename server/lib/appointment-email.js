'use strict';

// Branded appointment emails. The app runs on the salon computer and can't be
// reached from a customer's phone, so every action is something that works
// from any mail app: Confirm / Change / Cancel open a pre-filled reply to the
// salon, "Call" dials the salon, and the booking can be added to the
// customer's own calendar (attached .ics file or a Google Calendar link).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const COLORS = { primary: '#9d4f6a', ink: '#2d1d27', muted: '#8d7983', line: '#eee2e5', bg: '#fbf7f5', soft: '#f6e5ea' };

function whenParts(iso, tz) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-CA', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' }),
  };
}

const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// A calendar file the customer's phone or mail app can add with one tap.
function icsFile(a, salon) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Salon Manager//Appointments//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:appointment-${a.id}@salon-manager`,
    `SEQUENCE:${Math.floor(new Date(a.updatedAt || a.createdAt || Date.now()).getTime() / 1000) % 2147483647}`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(a.startAt)}`,
    `DTEND:${icsDate(a.endAt || a.startAt)}`,
    `SUMMARY:${icsText(`${salon.name}${a.services.length ? ': ' + a.services.map((s) => s.name).join(', ') : ''}`)}`,
    salon.address ? `LOCATION:${icsText(salon.address)}` : null,
    `DESCRIPTION:${icsText([salon.phone ? 'Phone: ' + salon.phone : null, 'To change or cancel, reply to the email or call us.'].filter(Boolean).join('\n'))}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText('Appointment at ' + salon.name)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n') + '\r\n';
}

function googleCalendarLink(a, salon) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${salon.name}${a.services.length ? ': ' + a.services.map((s) => s.name).join(', ') : ''}`,
    dates: `${icsDate(a.startAt)}/${icsDate(a.endAt || a.startAt)}`,
    details: salon.phone ? `Phone: ${salon.phone}` : '',
    location: salon.address || '',
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function mailto(to, subject, body) {
  return `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function button(href, label, primary) {
  const style = primary
    ? `background:${COLORS.primary};color:#ffffff;border:1px solid ${COLORS.primary};`
    : `background:#ffffff;color:${COLORS.primary};border:1px solid ${COLORS.primary};`;
  return `<a href="${esc(href)}" style="${style}display:inline-block;padding:12px 20px;border-radius:999px;font-weight:600;font-size:15px;text-decoration:none;margin:4px 6px 4px 0;">${esc(label)}</a>`;
}

const SUBJECTS = {
  confirmation: (n, w) => `Your appointment at ${n}: ${w.date}, ${w.time}`,
  updated: (n, w) => `Your appointment at ${n} has moved: ${w.date}, ${w.time}`,
  reminder: (n, w) => `Reminder: your appointment at ${n}, ${w.date}, ${w.time}`,
  cancelled: (n, w) => `Your appointment at ${n} on ${w.date} is cancelled`,
};
const HEADINGS = { confirmation: 'You’re booked in', updated: 'Your appointment has moved', reminder: 'See you soon', cancelled: 'Your appointment is cancelled' };
const INTROS = {
  confirmation: 'Thank you for booking with us. Here are your appointment details.',
  updated: 'Your appointment has a new date or time. Here are the updated details.',
  reminder: 'This is a friendly reminder of your upcoming appointment.',
  cancelled: 'Your appointment below has been cancelled. We’d love to see you another time.',
};

/**
 * Builds { to, replyTo, subject, text, html, attachments } for one appointment.
 * salon: { name, email, phone, address, logo (data URL), timezone }
 */
function buildAppointmentEmail(a, kind, salon) {
  const w = whenParts(a.startAt, salon.timezone);
  const first = String(a.customerName || '').trim().split(/\s+/)[0] || 'there';
  const services = a.services.map((s) => s.name).join(', ');
  const ref = `#${a.id}`;
  const active = kind !== 'cancelled';
  const replyBody = (verb) => `Hi ${salon.name},\n\n${verb}\n\nAppointment ${ref}: ${w.date} at ${w.time}${services ? ' (' + services + ')' : ''}\n\nThank you,\n${a.customerName}`;

  const actions = [];
  const L = salon.links;
  if (L && active) {
    // Real buttons: each opens this booking's page on the salon's website.
    actions.push({ href: L.confirm, label: 'Confirm', primary: true });
    actions.push({ href: L.change, label: 'Change time' });
    actions.push({ href: L.cancel, label: 'Cancel' });
  } else if (salon.email && active) {
    actions.push({ href: mailto(salon.email, `Confirm appointment ${ref}: ${w.date}, ${w.time}`, replyBody('I confirm my appointment.')), label: 'Confirm', primary: true });
    actions.push({ href: mailto(salon.email, `Change appointment ${ref}: ${w.date}, ${w.time}`, replyBody('I would like to change my appointment. A better time for me would be:\n\n')), label: 'Change time' });
    actions.push({ href: mailto(salon.email, `Cancel appointment ${ref}: ${w.date}, ${w.time}`, replyBody('I need to cancel my appointment.')), label: 'Cancel' });
  } else if (salon.email) {
    actions.push({ href: mailto(salon.email, `Book again`, `Hi ${salon.name},\n\nI would like to book a new appointment. A good time for me would be:\n\n\nThank you,\n${a.customerName}`), label: 'Book another time', primary: true });
  }
  const tel = salon.phone ? `tel:${salon.phone.replace(/[^\d+]/g, '')}` : null;
  if (tel) actions.push({ href: tel, label: `Call ${salon.phone}` });

  const row = (label, value) => value
    ? `<tr><td style="padding:6px 16px 6px 0;color:${COLORS.muted};font-size:14px;vertical-align:top;white-space:nowrap;">${esc(label)}</td><td style="padding:6px 0;color:${COLORS.ink};font-size:15px;font-weight:600;">${esc(value)}</td></tr>`
    : '';
  const logo = salon.logo ? `<img src="cid:salon-logo" alt="" width="64" height="64" style="display:block;margin:0 auto 10px;border-radius:14px;object-fit:contain;">` : '';
  const strike = active ? '' : 'text-decoration:line-through;';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(SUBJECTS[kind](salon.name, w))}</title></head>
<body style="margin:0;padding:0;background:${COLORS.bg};font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:${COLORS.ink};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};"><tr><td align="center" style="padding:28px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${COLORS.line};border-radius:20px;">
<tr><td style="padding:28px 28px 8px;text-align:center;">
${logo}<div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:${COLORS.primary};">${esc(salon.name)}</div>
</td></tr>
<tr><td style="padding:12px 28px 0;">
<h1 style="margin:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:28px;color:${COLORS.ink};">${esc(HEADINGS[kind])}</h1>
<p style="margin:0 0 4px;font-size:15px;line-height:1.5;color:${COLORS.ink};">Hi ${esc(first)},</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:${COLORS.ink};">${esc(INTROS[kind])}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:${COLORS.soft};border-radius:14px;"><tr><td style="padding:14px 18px;">
<table role="presentation" cellpadding="0" cellspacing="0" style="${strike}">
${row('Date', w.date)}${row('Time', w.time)}${row('Services', services)}${row('Where', salon.address)}
</table></td></tr></table>
</td></tr>
${actions.length ? `<tr><td style="padding:20px 28px 4px;">
<p style="margin:0 0 8px;font-size:14px;color:${COLORS.muted};">${active ? 'Please let us know:' : 'Want to come in another day?'}</p>
${actions.map((x) => button(x.href, x.label, x.primary)).join('')}
</td></tr>` : ''}
${active ? `<tr><td style="padding:14px 28px 0;font-size:14px;color:${COLORS.muted};line-height:1.5;">
Add it to your calendar: <a href="${esc(googleCalendarLink(a, salon))}" style="color:${COLORS.primary};">Google Calendar</a> or open the attached calendar file (Apple / Outlook).
</td></tr>` : ''}
<tr><td style="padding:22px 28px 26px;font-size:13px;color:${COLORS.muted};line-height:1.5;border-top:1px solid ${COLORS.line};margin-top:16px;">
${esc(salon.name)}${salon.address ? '<br>' + esc(salon.address).replace(/\n/g, '<br>') : ''}${salon.phone ? '<br>' + esc(salon.phone) : ''}<br>
Appointment ${esc(ref)}. ${L && active ? `<a href="${esc(L.view)}" style="color:${COLORS.primary};">Manage your appointment</a> or reply to this email.` : 'You can also just reply to this email.'}
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `Hi ${first},`,
    '',
    INTROS[kind],
    '',
    `Date: ${w.date}`,
    `Time: ${w.time}`,
    services ? `Services: ${services}` : null,
    salon.address ? `Where: ${salon.address}` : null,
    '',
    active && L ? `Confirm, change or cancel here: ${L.view}` : active ? 'To confirm, change or cancel, just reply to this email' + (salon.phone ? ` or call ${salon.phone}.` : '.') : salon.phone ? `To book another time, reply or call ${salon.phone}.` : 'To book another time, just reply to this email.',
    '',
    salon.name,
    `Appointment ${ref}`,
  ].filter((l) => l !== null).join('\n');

  const attachments = [];
  if (active) attachments.push({ filename: 'appointment.ics', content: icsFile(a, salon), contentType: 'text/calendar; charset=utf-8' });
  const logoMatch = /^data:(image\/(?:png|jpeg|jpg));base64,(.+)$/.exec(salon.logo || '');
  if (logoMatch) attachments.push({ filename: 'logo.' + (logoMatch[1].endsWith('png') ? 'png' : 'jpg'), content: Buffer.from(logoMatch[2], 'base64'), contentType: logoMatch[1], cid: 'salon-logo' });
  const htmlOut = logoMatch ? html : html.replace(logo, '');

  return { to: a.customerEmail, replyTo: salon.email || undefined, subject: SUBJECTS[kind](salon.name, w), text, html: htmlOut, attachments };
}

module.exports = { buildAppointmentEmail, icsFile, googleCalendarLink };
