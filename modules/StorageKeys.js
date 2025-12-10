
// ===== Storage key helpers =====
// Centralized helper để tránh string literal rải rác

const ACK_KEY_PREFIX = 'ack-'; // ack-YYYYMMDD
const IGNORE_KEY_PREFIX = 'ignore-'; // ignore-YYYYMMDD when user didn't ack by the acknowledgement deadline
const PENDING_KEY = 'pending-ack-date'; // stores YYYYMMDD when auto modal was shown
const TAB_EMAILS_KEY = 'tabMailboxEmails'; // maps tabId -> mailbox email captured from content script

export const StorageKeys = {
  ack(dateKey) {
    return `${ACK_KEY_PREFIX}${dateKey}`;      // ack-YYYYMMDD
  },
  ignore(dateKey) {
    return `${IGNORE_KEY_PREFIX}${dateKey}`;   // ignore-YYYYMMDD
  },
  pending: PENDING_KEY,                        // 'pending-ack-date'
  tabEmails: TAB_EMAILS_KEY,                   // 'tabMailboxEmails'
  untreatedCountCache: 'untreatedCountCache',
  profileEmailCache: 'profileEmailCache',
  profileBackoffUntil: 'profileBackoffUntil',
  countBackoffUntil: 'countBackoffUntil',
};