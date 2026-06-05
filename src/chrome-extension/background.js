chrome.action.onClicked.addListener(() => {
  chrome.sidePanel.open({ windowId: undefined });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getPageContent') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'extractContent' }, (response) => {
          sendResponse(response || { error: 'no response from content script' });
        });
      }
    });
    return true;
  }
});
