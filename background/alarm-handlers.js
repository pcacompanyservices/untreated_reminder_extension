import { TARGET_HOUR } from './config.js';
import { isWeekend, getAckDeadlineFor } from './utils.js';

/**
 * Schedules the next daily alarm at TARGET_HOUR on the next working day.
 */
export function scheduleNextAlarm() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(TARGET_HOUR, 0, 0, 0);
  if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
  
  // Skip weekends
  while (isWeekend(nextRun)) {
    nextRun.setDate(nextRun.getDate() + 1);
    nextRun.setHours(TARGET_HOUR, 0, 0, 0);
  }

  // Clear existing alarm before creating a new one
  chrome.alarms.clear('daily-ack', () => {
    chrome.alarms.create('daily-ack', { when: nextRun.getTime() });
    console.log('[PCA] Next daily ACK alarm scheduled at', nextRun.toString());
  });
}

/**
 * Schedules an hourly alarm at the top of the hour to refresh exact _UNTREATED count cache.
 */
export function scheduleHourlyCount() {
  try {
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setMinutes(0, 0, 0);
    if (nextRun <= now) {
      nextRun.setHours(nextRun.getHours() + 1);
    }

    chrome.alarms.clear('untreated-hourly', () => {
      chrome.alarms.create('untreated-hourly', {
        when: nextRun.getTime(),
        periodInMinutes: 60,
      });
      console.log('[PCA] Hourly untreated count refresh scheduled at', nextRun.toString());
    });
  } catch (e) {
    console.warn('[PCA] scheduleHourlyCount failed', e);
  }
}

/**
 * Schedule the acknowledgement deadline at the start of the next working day (08:00 local)
 */
export async function scheduleAckDeadlineAlarm(dateKey) {
  const deadline = getAckDeadlineFor(dateKey);
  const name = `ack-deadline-${dateKey}`;
  try {
    chrome.alarms.create(name, { when: deadline.getTime() });
    console.log('[PCA] Ack deadline alarm scheduled at', deadline.toString(), 'for', dateKey);
  } catch (e) {
    console.warn('[PCA] Failed to schedule ack deadline alarm', name, e);
  }
}

export async function clearAckDeadlineAlarm(dateKey) {
  const name = `ack-deadline-${dateKey}`;
  try {
    await chrome.alarms.clear(name);
  } catch (e) {
    console.error('[PCA] clearAckDeadlineAlarm error:', e);
  }
}
