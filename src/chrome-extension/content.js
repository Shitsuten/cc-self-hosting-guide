chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'extractContent') {
    const title = document.title;
    const url = window.location.href;
    const selection = window.getSelection().toString();
    const meta = document.querySelector('meta[name="description"]')?.content || '';

    let bodyText = '';
    const article = document.querySelector('article') || document.querySelector('main') || document.body;
    if (article) {
      bodyText = article.innerText.slice(0, 5000);
    }

    sendResponse({ title, url, selection, meta, bodyText });
  }
  return true;
});
