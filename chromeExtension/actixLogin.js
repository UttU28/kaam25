// Runs on ActixOne. When the Kaam25 app opened the page (#kaamLogin=...), it:
//   1. gets you to /outdoor/upload (signing in with Microsoft if needed),
//   2. adds the extra email, attaches the log files and clicks validate,
//   3. with submit on: clicks Submit, waits for the upload and reads the Job ID;
//      with submit off: finds the Submit button but doesn't click it.
(async () => {
  const uploadPath = "/outdoor/upload";
  const loginWaitMs = 2500;  // give ActixOne time to redirect a logged-in user
  const settleMs = 3000;     // how long a non-login page must stay put before we go to upload
  const maxMicrosoftClicks = 2;

  const params = new URLSearchParams(location.hash.slice(1));
  const requestId = params.get("kaamLogin");
  if (requestId) {
    // Reuse the ActixOne tab from the last run: the job moves there and this tab closes.
    if (await chrome.runtime.sendMessage({ type: "reuseTab", kind: "actix", url: location.href })) return;
    history.replaceState(null, "", location.pathname + location.search);
    sessionStorage.removeItem("kaamMicrosoftClicks");
    await chrome.runtime.sendMessage({
      type: "jobStart", kind: "actix", requestId,
      data: {
        account: params.get("kaamAccount") || "", email: params.get("kaamEmail") || "",
        submit: params.get("kaamSubmit") === "1", closeTab: params.get("kaamClose") === "1",
      },
    });
  }

  const job = await chrome.runtime.sendMessage({ type: "jobState" });
  if (!job || job.kind !== "actix") return;

  const debugLog = (text) => chrome.runtime.sendMessage({ type: "log", text }).catch(() => {});
  debugLog(`actix job running on ${location.pathname}`);
  let timer = null;
  const finish = (ok, error, summary, jobId) => {
    debugLog(`finished: ok=${ok} ${error || summary || ""}`);
    clearInterval(timer);
    sessionStorage.removeItem("kaamMicrosoftClicks");
    // A finished upload (with its Job ID) leaves nothing to do in this tab: close it now.
    // Anything else stays open so you can see what happened (closed when you click Done in the app).
    const done = !!(ok && jobId);
    chrome.runtime.sendMessage({ type: "jobDone", result: { ok, error, summary, jobId, closeTab: done, keepTab: !done } });
  };

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, timeoutMs, stepMs = 400) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const value = check();
      if (value) return value;
      await sleep(stepMs);
    }
    return null;
  };
  const isVisible = (el) => !!el && el.getClientRects().length > 0;

  // Real mouse click through the extension (same as you clicking).
  const realClick = async (el) => {
    el.scrollIntoView({ block: "center" });
    const rect = el.getBoundingClientRect();
    const ok = await chrome.runtime.sendMessage({
      type: "realClick", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    });
    if (!ok) el.click();
  };

  const base64ToBytes = (text) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  // ---------- upload page ----------
  const addEmail = async (email) => {
    const emailField = await waitFor(() => Array.from(document.querySelectorAll(".v-input"))
      .find((el) => /email/i.test((el.querySelector("label") || {}).innerText || "")), 20000);
    if (!emailField) throw new Error("Couldn't find the Email field on the upload page.");

    const hasEmail = () => Array.from(emailField.querySelectorAll(".v-chip__content"))
      .some((chip) => chip.innerText.trim().toLowerCase() === email.toLowerCase());
    if (hasEmail()) {
      debugLog("email already in the list");
      return "email already there";
    }

    const input = emailField.querySelector('input[type="text"]');
    if (!input) throw new Error("Couldn't find where to type in the Email field.");
    await realClick(input);
    await sleep(400);
    const typed = await chrome.runtime.sendMessage({ type: "realType", text: email, pressEnter: true });
    if (!typed) throw new Error("Couldn't type the email into the Email field.");
    if (!(await waitFor(hasEmail, 5000))) {
      throw new Error(`Typed ${email} and pressed Enter, but it didn't appear in the Email field.`);
    }
    debugLog("email added");
    document.body.click(); // close the email dropdown
    return "email added";
  };

  const attachFiles = async () => {
    const fileInput = await waitFor(() => document.querySelector('.v-file-input input[type="file"]'), 15000);
    if (!fileInput) throw new Error("Couldn't find the File Upload box.");
    const reply = await chrome.runtime.sendMessage({ type: "getFiles" });
    if (!reply || !reply.files) throw new Error((reply && reply.error) || "Couldn't get the log files from the app.");

    const transfer = new DataTransfer();
    for (const file of reply.files) {
      transfer.items.add(new File([base64ToBytes(file.data)], file.name, { lastModified: file.lastModified }));
    }
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    const names = reply.files.map((file) => file.name);
    debugLog(`attached ${names.length} files: ${names.join(", ")}`);
    return names;
  };

  const findErrorPopup = () => Array.from(document.querySelectorAll(".v-overlay"))
    .find((overlay) => getComputedStyle(overlay).display !== "none" &&
      Array.from(overlay.querySelectorAll("i.material-icons")).some((icon) => icon.innerText.trim() === "error"));

  const validateFiles = async (names) => {
    const button = await waitFor(() => {
      const el = document.querySelector('button[aria-label="validate files"]');
      return el && !el.disabled ? el : null;
    }, 15000);
    if (!button) throw new Error("The validate (shield) button never became clickable after attaching files.");
    debugLog("clicking validate");
    button.click();

    const rowsFor = () => {
      const rows = Array.from(document.querySelectorAll(".v-data-table tbody tr"));
      const ours = names.map((name) => rows.find((row) => row.innerText.includes(name)));
      return ours.every(Boolean) ? ours : null;
    };
    const outcome = await waitFor(() => {
      const popup = findErrorPopup();
      if (popup) return { error: popup.innerText.replace(/\berror\b/, "").replace(/\s+/g, " ").trim() || "unknown error" };
      return rowsFor() ? { done: true } : null;
    }, 180000, 700);
    if (!outcome) throw new Error("Validation didn't finish within 3 minutes.");
    if (outcome.error) throw new Error(`Validation failed: ${outcome.error}`);

    await sleep(1500); // let the Valid column settle
    const rows = rowsFor() || [];
    const invalid = names.filter((name, i) => !rows[i] || !/check_circle/.test(rows[i].innerText));
    if (invalid.length) throw new Error(`Validation flagged: ${invalid.join(", ")}`);
    debugLog(`validated ${names.length} files, all valid`);
  };

  const findSubmitButton = () => Array.from(document.querySelectorAll("button"))
    .find((el) => isVisible(el) && /^submit$/i.test(el.innerText.trim()));
  const isDisabled = (el) => el.disabled || el.classList.contains("v-btn--disabled");

  const findSuccessPopup = () => Array.from(document.querySelectorAll(".v-overlay"))
    .find((overlay) => getComputedStyle(overlay).display !== "none" &&
      /files uploaded successfully/i.test(overlay.innerText || ""));

  // Clicks Submit, waits for "Files Uploaded Successfully" and returns its Job ID.
  const submitUpload = async () => {
    const submit = await waitFor(() => {
      const el = findSubmitButton();
      return el && !isDisabled(el) ? el : null;
    }, 15000);
    if (!submit) throw new Error("Files validated, but the Submit button never became clickable.");
    if (!(await chrome.runtime.sendMessage({ type: "stillWanted" }))) {
      throw new Error("Stopped from the app - Submit was not clicked.");
    }
    debugLog("clicking Submit");
    submit.click();

    const outcome = await waitFor(() => {
      const errorPopup = findErrorPopup();
      if (errorPopup) {
        return { error: errorPopup.innerText.replace(/\berror\b/, "").replace(/\s+/g, " ").trim() || "unknown error" };
      }
      const successPopup = findSuccessPopup();
      if (!successPopup) return null;
      const match = successPopup.innerText.match(/Job ID:\s*([A-Za-z0-9-]+)/i);
      return match ? { jobId: match[1], popup: successPopup } : null;
    }, 15 * 60 * 1000, 1000);
    if (!outcome) throw new Error("The upload didn't finish within 15 minutes. Check the ActixOne tab.");
    if (outcome.error) throw new Error(`Upload failed: ${outcome.error}`);
    debugLog(`uploaded, Job ID ${outcome.jobId}`);

    const okay = Array.from(outcome.popup.querySelectorAll("button"))
      .find((el) => /^okay$/i.test((el.innerText || "").trim()));
    if (okay) okay.click();
    return outcome.jobId;
  };

  const prepareUpload = async () => {
    const emailNote = job.data.email ? await addEmail(job.data.email) : "no extra email";
    const names = await attachFiles();
    await validateFiles(names);
    const done = `ActixOne: ${emailNote}, ${names.length} files attached and validated`;
    if (!job.data.submit) {
      if (!findSubmitButton()) throw new Error("Files validated, but the Submit button wasn't found.");
      debugLog("found the Submit button - NOT clicked (submit is off)");
      return { summary: `${done}. Submit not clicked (ACTIX_SUBMIT is off).`, jobId: null };
    }
    const jobId = await submitUpload();
    return { summary: `${done}, submitted. Job ID ${jobId}.`, jobId };
  };

  // ---------- getting to the upload page ----------
  const findMicrosoftButton = () =>
    Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .find((el) => /login with microsoft/i.test(el.innerText || ""));

  const pageStart = Date.now();
  let lastPath = location.pathname;
  let pathSince = Date.now();
  let clickedHere = false;
  let redirected = false;

  const uploadSettleMs = 2500; // if we're not signed in, ActixOne sends us to /login within this

  const startLoop = () => { timer = setInterval(tick, 500); };
  const tick = () => {
    const path = location.pathname;
    if (path !== lastPath) { lastPath = path; pathSince = Date.now(); }

    if (path.startsWith(uploadPath)) {
      if (Date.now() - pathSince < uploadSettleMs) return; // signed in? wait and see
      clearInterval(timer);
      debugLog("on the upload page (signed in), preparing the upload");
      prepareUpload().then(
        ({ summary, jobId }) => finish(true, null, summary, jobId),
        (error) => {
          if (!location.pathname.startsWith(uploadPath)) {
            debugLog("ActixOne left the upload page (sign-in needed?), carrying on");
            startLoop();
            return;
          }
          finish(false, error.message);
        });
      return;
    }

    if (path.startsWith("/login")) {
      if (clickedHere || Date.now() - pageStart < loginWaitMs) return;
      const button = findMicrosoftButton();
      if (!button) return;
      const clicks = Number(sessionStorage.getItem("kaamMicrosoftClicks") || 0);
      if (clicks >= maxMicrosoftClicks) {
        finish(false, "Still on the ActixOne login page after signing in with Microsoft.");
        return;
      }
      sessionStorage.setItem("kaamMicrosoftClicks", String(clicks + 1));
      clickedHere = true;
      debugLog(`clicking Login with Microsoft (attempt ${clicks + 1})`);
      button.click();
      return;
    }

    // Logged in but on some other page: go to the upload page once it settles.
    if (!redirected && Date.now() - pathSince > settleMs) {
      redirected = true;
      location.assign(uploadPath);
    }
  };
  startLoop();
})();
