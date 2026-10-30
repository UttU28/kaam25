// Runs on the app's little http://127.0.0.1:47821/tems page. Hands the job to the background,
// which uses your open TEMS Paragon tab (or turns this tab into one).
(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const requestId = params.get("kaamId");
  if (!requestId) return;
  chrome.runtime.sendMessage({
    type: "temsStart", requestId,
    data: {
      url: params.get("kaamUrl") || "http://localhost:8080/",
      wo: params.get("kaamWo") || "", project: params.get("kaamProject") || "",
      assignWo: params.get("kaamAssignWo") || "",
    },
  });
})();
