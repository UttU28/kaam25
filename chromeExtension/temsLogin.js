// Runs on the Infovista login page (the popup TEMS Paragon opens for TEMS Cloud). Only for a
// Kaam25 TEMS job: waits for Chrome to fill your saved user and password (it never reads or
// types them), then clicks Continue with a real click. The popup closes itself after login.
(async () => {
  const job = await chrome.runtime.sendMessage({ type: "jobState" });
  if (!job || job.kind !== "tems") return;
  const form = document.querySelector("#kc-form-login");
  if (!form) return; // not the login form (e.g. already signed in, redirecting)

  const fillWaitMs = 15000;
  const maxClicks = 2;
  const debugLog = (text) => chrome.runtime.sendMessage({ type: "log", text: `tems login: ${text}` }).catch(() => {});
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isFilled = (box) => !!box && (box.matches(":autofill") || box.value.length > 0);

  const clicks = Number(sessionStorage.getItem("kaamTemsLoginClicks") || 0);
  if (clicks >= maxClicks) { debugLog("already clicked Continue twice - leaving it to you"); return; }

  const end = Date.now() + fillWaitMs;
  let user, password;
  while (Date.now() < end) {
    user = document.querySelector("#username");
    password = document.querySelector("#password");
    if (isFilled(user) && isFilled(password)) break;
    await sleep(300);
  }
  if (!isFilled(user) || !isFilled(password)) {
    debugLog(`Chrome didn't fill the login (user=${isFilled(user)} password=${isFilled(password)}) - log in yourself`);
    return;
  }
  await sleep(400); // let Chrome finish filling
  const button = document.querySelector("#kc-login");
  if (!button) return;
  sessionStorage.setItem("kaamTemsLoginClicks", String(clicks + 1));
  button.scrollIntoView({ block: "center" });
  const rect = button.getBoundingClientRect();
  debugLog("saved login filled - clicking Continue");
  // A real click so Chrome hands the saved password to the form.
  const clicked = await chrome.runtime.sendMessage({ type: "realClick", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  if (!clicked) button.click();
})();
