// --- Self-install web app: creates my triggers and ensures label exists ---
function doGet(e) {
  try {
    // Make sure the label exists
    getOrCreateUntreatedLabel_();

    // Create (or refresh) my triggers
    setupTriggers();

    return HtmlService
      .createHtmlOutput('<div style="font-family:Arial;padding:16px">INSTALLED<br/>Triggers set for your account. You can close this tab.</div>')
      .setTitle('Mailbox Manager Installer');
  } catch (err) {
    return HtmlService
      .createHtmlOutput('<div style="font-family:Arial;padding:16px;color:#b00020">Error: ' + String(err) + '</div>')
      .setTitle('Mailbox Manager Installer');
  }
}

// --- Optional: uninstall my triggers if needed ---
function doGet_uninstall(e) {
  ScriptApp.getProjectTriggers().forEach(tr => ScriptApp.deleteTrigger(tr));
  return HtmlService
    .createHtmlOutput('<div style="font-family:Arial;padding:16px">UNINSTALLED<br/>Your triggers were removed.</div>')
    .setTitle('Mailbox Manager Uninstaller');
}