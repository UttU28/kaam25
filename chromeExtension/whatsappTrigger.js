// Runs on the app's little http://127.0.0.1:47821/whatsapp page. Hands the share job to
// the background, which uses your open WhatsApp Web tab (or turns this tab into one).
(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const requestId = params.get("kaamId");
  if (!requestId) return;
  chrome.runtime.sendMessage({
    type: "whatsappStart",
    requestId,
    data: {
      group: params.get("kaamGroup") || "",
      caption: params.get("kaamCaption") || "",
      send: params.get("kaamSend") === "1",
      attempt: Number(params.get("kaamAttempt") || 1),
      checkFirst: params.get("kaamCheckFirst") === "1",
      text: params.get("kaamText") || "",  // a plain message (no file): typed in the chat box and sent
    },
  });
})();
