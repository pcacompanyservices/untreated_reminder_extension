// Close any open modals across Gmail tabs
export async function closeAllGmailModals_() {
  const { matchedTabs } = await getMatchedGmailTabs_();
  for (const tab of matchedTabs) {
    await sendMessageOrInject_(tab.id, { type: 'CLOSE_MODAL' });
  }
}
