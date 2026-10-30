// Runs on the Microsoft sign-in page, but only during a login the Kaam25 app started.
// Picks your account, clicks Sign in once Chrome has filled your saved password,
// and answers "Stay signed in?" with Yes. It never reads or types the password.
(async () => {
  const job = await chrome.runtime.sendMessage({ type: "jobState" });
  if (!job || job.kind !== "actix") return;
  const account = (job.data.account || "").toLowerCase();

  const debugLog = (text) => chrome.runtime.sendMessage({ type: "log", text }).catch(() => {});
  debugLog("microsoft sign-in page");
  const clicked = new Set();
  const clickOnce = (key, el) => {
    if (clicked.has(key)) return;
    clicked.add(key);
    debugLog(`clicking ${key}`);
    el.click();
  };
  const isVisible = (el) => !!el && el.getClientRects().length > 0;

  // Real mouse click through the extension, so Chrome releases the saved password.
  const realClickOnce = async (key, el) => {
    if (clicked.has(key)) return;
    clicked.add(key);
    debugLog(`real-clicking ${key}`);
    el.scrollIntoView({ block: "center" });
    const rect = el.getBoundingClientRect();
    const ok = await chrome.runtime.sendMessage({
      type: "realClick", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    });
    if (!ok) el.click();
  };
  const pageText = () => (document.body ? document.body.innerText : "");

  const findButton = (pattern) =>
    Array.from(document.querySelectorAll('input[type="submit"], button, [role="button"]'))
      .find((el) => isVisible(el) && pattern.test((el.value || el.innerText || "").trim()));

  // Innermost visible clickable element that mentions the account
  // (the tile button, not the list item wrapped around it).
  const findAccountTile = () => {
    if (!account) return null;
    const matches = Array.from(document.querySelectorAll('[role="button"], [role="listitem"], [data-test-id], .table'))
      .filter((el) => isVisible(el) &&
        ((el.innerText || "").toLowerCase().includes(account) ||
         (el.getAttribute("data-test-id") || "").toLowerCase() === account));
    const innermost = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
    return innermost.find((el) => el.getAttribute("role") === "button") || innermost[0] || null;
  };

  setInterval(() => {
    const passwordBox = document.querySelector('input[type="password"]');
    if (isVisible(passwordBox)) {
      const isFilled = passwordBox.matches(":autofill") || passwordBox.value.length > 0;
      const signIn = findButton(/^sign in$/i);
      if (isFilled && signIn) realClickOnce("signIn", signIn);
      return;
    }

    if (/pick an account/i.test(pageText())) {
      const tile = findAccountTile();
      if (tile) clickOnce("account", tile);
      return;
    }

    if (/stay signed in/i.test(pageText())) {
      const yes = findButton(/^yes$/i);
      if (yes) clickOnce("staySignedIn", yes);
    }
  }, 600);
})();
