// ===== AckService: quản lý ACK / IGNORE / PENDING cho từng ngày =====
import { StorageKeys } from './StorageKeys.js';
import { getAckDeadlineFor_, formatShortDateTime_, clearAckDeadlineAlarm_, scheduleAckDeadlineAlarm_ } from './AckHelpers.js';
import { closeAllGmailModals_ } from './ModalHelpers.js';

export const AckService = {
  async getState(dateKey) {
    const ackKey    = StorageKeys.ack(dateKey);
    const ignoreKey = StorageKeys.ignore(dateKey);
    const st = await chrome.storage.local.get([ackKey, ignoreKey]);
    if (st[ackKey]) return 'acked';
    if (st[ignoreKey]) return 'ignored';
    return 'none';
  },

  async markPending(dateKey) {
    await chrome.storage.local.set({ [StorageKeys.pending]: dateKey });
    const deadline = getAckDeadlineFor_(dateKey);
    await scheduleAckDeadlineAlarm_(dateKey);
    console.log(
      '[PCA][AckService] Pending set for',
      dateKey,
      'deadline at',
      formatShortDateTime_(deadline)
    );
  },

  async clearPending(dateKey) {
    const st = await chrome.storage.local.get(StorageKeys.pending);
    if (st[StorageKeys.pending] === dateKey) {
      await chrome.storage.local.remove(StorageKeys.pending);
    }
    await clearAckDeadlineAlarm_(dateKey);
  },

  // Được gọi khi Chrome khởi động / cài đặt lại
  async runHousekeeping() {
    const st = await chrome.storage.local.get(StorageKeys.pending);
    const pendingDateKey = st[StorageKeys.pending];
    if (!pendingDateKey) return;

    const state = await this.getState(pendingDateKey);

    // Nếu ngày đó đã ACK hoặc IGNORE → dọn pending + alarm
    if (state === 'acked' || state === 'ignored') {
      await chrome.storage.local.remove(StorageKeys.pending).catch(() => {});
      await clearAckDeadlineAlarm_(pendingDateKey).catch(() => {});
      return;
    }

    const now      = new Date();
    const deadline = getAckDeadlineFor_(pendingDateKey);

    if (now >= deadline) {
      // Quá deadline mà vẫn chưa ACK/IGNORE → mark ignore
      const ignoreKey = StorageKeys.ignore(pendingDateKey);
      await chrome.storage.local.set({ [ignoreKey]: true });
      await chrome.storage.local.remove(StorageKeys.pending);
      await clearAckDeadlineAlarm_(pendingDateKey);

      // Best-effort cleanup cho legacy EOD alarm
      try {
        await chrome.alarms.clear(`eod-${pendingDateKey}`);
      } catch {}

      await closeAllGmailModals_();
      console.log(
        '[PCA][AckService] Housekeeping marked missed acknowledgement for',
        pendingDateKey
      );
    } else {
      // Chưa đến deadline → ensure alarm tồn tại
      await scheduleAckDeadlineAlarm_(pendingDateKey);
    }
  },

  // Được gọi từ alarm "ack-deadline-YYYYMMDD"
  async handleDeadlineAlarm(dateKey) {
    console.log(
      '[PCA][AckService] Deadline reached for',
      dateKey,
      'at',
      formatShortDateTime_(new Date())
    );

    const ackKey    = StorageKeys.ack(dateKey);
    const ignoreKey = StorageKeys.ignore(dateKey);

    const st = await chrome.storage.local.get([ackKey, ignoreKey, StorageKeys.pending]);
    const alreadyAcked   = !!st[ackKey];
    const alreadyIgnored = !!st[ignoreKey];

    if (!alreadyAcked && !alreadyIgnored) {
      await chrome.storage.local.set({ [ignoreKey]: true });

      if (st[StorageKeys.pending] === dateKey) {
        await chrome.storage.local.remove(StorageKeys.pending);
      }

      await closeAllGmailModals_();
      console.log('[PCA][AckService] Missed ACK; marked ignore for', dateKey);
    }

    await clearAckDeadlineAlarm_(dateKey);
  },
};
