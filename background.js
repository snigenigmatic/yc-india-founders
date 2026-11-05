const YC_PAGE = /^https:\/\/www\.ycombinator\.com\/(founders|companies)(\/?$|\?|#)/;

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && YC_PAGE.test(tab.url)) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "ycif-toggle" });
      return;
    } catch (e) {}
  }
  chrome.tabs.create({ url: "https://www.ycombinator.com/founders#ycif" });
});
