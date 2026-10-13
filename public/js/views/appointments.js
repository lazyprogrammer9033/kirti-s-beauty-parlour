import { h, clear, icon } from '../ui.js';
import { pageHeader } from './shared.js';

// Appointments are planned for a later version. The database already has
// appointment tables, so this screen can be built without changing existing data.
export async function render(view) {
  clear(view,
    pageHeader('Appointments', 'Coming in a future version.'),
    h('div.card.coming',
      icon('calendar', 40),
      h('h2.display', 'Appointment calendar is on the way'),
      h('p.muted', 'For now, use “New Visit” when a customer arrives. The system is already prepared for:'),
      h('ul.coming-list',
        ['Calendar view by day and week', 'Book, reschedule and cancel', 'Appointment reminders by email or SMS', 'Customer appointment history', 'Staff availability'].map((t) => h('li', icon('check', 18), t))),
      h('a.btn.primary.lg', { href: '#/visit' }, icon('sparkles', 20), 'Start a walk-in visit')));
}
