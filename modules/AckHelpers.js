const ACK_DEADLINE_HOUR = 8; // Local hour when the next working day begins (ack deadline time)
export function getNextAckDeadlineFromDate_(date) {
  // Returns a Date set to the acknowledgement deadline time on the next working day from the given Date
  const d = new Date(date);
  // Move to next day first
  d.setDate(d.getDate() + 1);
  d.setHours(ACK_DEADLINE_HOUR, 0, 0, 0);
  // If it's weekend, advance to Monday at 08:00
  while (isWeekend_(d)) {
    d.setDate(d.getDate() + 1);
    d.setHours(ACK_DEADLINE_HOUR, 0, 0, 0);
  }
  return d;
}

export function getAckDeadlineFor_(dateKey) {
  // Compute the deadline (Date) for acknowledging for the provided dateKey (YYYYMMDD)
  const y = Number(dateKey.slice(0, 4));
  const m = Number(dateKey.slice(4, 6)) - 1;
  const d = Number(dateKey.slice(6, 8));
  const base = new Date(y, m, d, 0, 0, 0, 0); // start of that day
  return getNextAckDeadlineFromDate_(base);
}

export function formatShortDateTime_(dt) {
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  // Return time first (24h) then date: "HH:MM DD/MM/YYYY"
  return `${hh}:${min} ${dd}/${mm}/${yyyy}`;
}
export async function clearAckDeadlineAlarm_(dateKey) {
  const name = `ack-deadline-${dateKey}`;
  try { await chrome.alarms.clear(name); } catch {}
}

export async function scheduleAckDeadlineAlarm_(dateKey) {
  // Schedule the acknowledgement deadline at the start of the next working day (08:00 local)
  const deadline = getAckDeadlineFor_(dateKey);
  const name = `ack-deadline-${dateKey}`;
  try {
    chrome.alarms.create(name, { when: deadline.getTime() });
    console.log('[PCA] Ack deadline alarm scheduled at', deadline.toString(), 'for', dateKey);
  } catch (e) {
    console.warn('[PCA] Failed to schedule ack deadline alarm', name, e);
  }
}