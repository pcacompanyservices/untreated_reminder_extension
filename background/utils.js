import { ACK_DEADLINE_HOUR, WORK_START_HOUR, WORK_END_HOUR } from './config.js';

export function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday(0) or Saturday(6)
}

export function isWithinWorkingHours(date) {
  const h = date.getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}

export function formatShortDateTime(dt) {
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  // Return time first (24h) then date: "HH:MM DD/MM/YYYY"
  return `${hh}:${min} ${dd}/${mm}/${yyyy}`;
}

export function getNextAckDeadlineFromDate(date) {
  // Returns a Date set to the acknowledgement deadline time on the next working day from the given Date
  const d = new Date(date);
  // Move to next day first
  d.setDate(d.getDate() + 1);
  d.setHours(ACK_DEADLINE_HOUR, 0, 0, 0);
  // If it's weekend, advance to Monday at 08:00
  while (isWeekend(d)) {
    d.setDate(d.getDate() + 1);
    d.setHours(ACK_DEADLINE_HOUR, 0, 0, 0);
  }
  return d;
}

export function getAckDeadlineFor(dateKey) {
  // Compute the deadline (Date) for acknowledging for the provided dateKey (YYYYMMDD)
  const y = Number(dateKey.slice(0, 4));
  const m = Number(dateKey.slice(4, 6)) - 1;
  const d = Number(dateKey.slice(6, 8));
  const base = new Date(y, m, d, 0, 0, 0, 0); // start of that day
  return getNextAckDeadlineFromDate(base);
}

export function isGmailUrl(url) {
  return typeof url === 'string' && url.startsWith('https://mail.google.com/');
}
