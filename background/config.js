// ===== Settings =====
export const LABEL_NAME = '_UNTREATED';
export const TARGET_HOUR = 16;
export const ACK_RECORDS_KEY = 'ack-records'; // { "YYYYMMDD": { state, shownAt, deadlineAt, source } }
export const ACK_DEADLINE_HOUR = 8; // Local hour when the next working day begins (ack deadline time)
export const WORK_START_HOUR = 8; // Working hours start (08:00 local)
export const WORK_END_HOUR = 18; // Working hours end (18:00 local, exclusive)
export const GMAIL_URL_MATCH = 'https://mail.google.com/*';
export const TAB_EMAILS_KEY = 'tabMailboxEmails'; // maps tabId -> mailbox email captured from content script
export const CLEANUP_DAYS = 7; // Days to keep old ack records

// ===== Triage Settings =====
export const TRIAGE_SCAN_DAYS = 5; // How many days back to scan for unread/unlabeled emails
export const TRIAGE_MAX_THREADS = 100; // Max threads to process per triage run (quota-friendly)

