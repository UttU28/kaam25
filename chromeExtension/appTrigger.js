// Runs on the app's little http://127.0.0.1:47821/app page (opened when Kaam25 starts).
// The background switches to your open Kaam25 tab (e.g. a pinned one) and closes this page,
// or turns this page into the app when no Kaam25 tab is open.
(() => {
  const url = new URLSearchParams(location.hash.slice(1)).get("url") || "";
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) return;
  chrome.runtime.sendMessage({ type: "focusApp", url });
})();
