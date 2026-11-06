// Injected into your WhatsApp Web tab: opens the chat once, then for each WO (one, or a batch from
// End Tickets) attaches the renamed CSV, types the report as its caption and (only if the app says
// so) presses Send; the TEMS picture follows as its own message through Photos & videos, so it
// shows as a photo. Each step waits for exactly what it needs (the preview, the Send button, our
// message in the chat) - not for WhatsApp to go quiet, which a busy group never does.
(async () => {
  const job = await chrome.runtime.sendMessage({ type: "jobState" });
  if (!job || job.kind !== "whatsapp") return;
  if (window.kaamShareRunning === job.requestId) return; // already running for this share
  // A newer share (e.g. a retry) takes over; an older one still running here stops quietly.
  window.kaamShareRunning = job.requestId;
  const { group, send } = job.data;
  let caption = job.data.caption || "";
  const attempt = job.data.attempt || 1;
  // Look in the chat for this WO's file before sending: on a retry (the try before may have sent
  // it without hearing back) and when the app asks (End Tickets: only what wasn't shared yet).
  const checkFirst = attempt > 1 || !!job.data.checkFirst;
  const replacedError = "replaced by a newer share";
  const stopIfReplaced = () => {
    if (window.kaamShareRunning !== job.requestId) throw new Error(replacedError);
  };

  const debugLog = (text) => chrome.runtime.sendMessage({ type: "log", text: `whatsapp: ${text}` }).catch(() => {});
  const finish = (result) => {
    debugLog(`finished: ${JSON.stringify(result)}`);
    window.kaamShareRunning = null;
    chrome.runtime.sendMessage({ type: "jobDone", result });
  };

  // ---------- helpers ----------
  const sleep = async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    stopIfReplaced();
  };
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const waitFor = async (check, timeoutMs, stepMs = 200) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      stopIfReplaced();
      const value = check();
      if (value) return value;
      await sleep(stepMs);
    }
    return null;
  };
  // Waits until `root` stops changing for quietMs (gives up quietly after timeoutMs).
  const waitForQuiet = (root, quietMs, timeoutMs) => new Promise((resolve) => {
    if (!root) return resolve(false);
    let lastChange = Date.now();
    const observer = new MutationObserver(() => { lastChange = Date.now(); });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const isQuiet = Date.now() - lastChange >= quietMs;
      if (isQuiet || Date.now() > end) {
        observer.disconnect();
        resolve(isQuiet);
      } else {
        setTimeout(tick, 250);
      }
    };
    tick();
  });
  const isLoadingShown = (root = document) =>
    Array.from(root.querySelectorAll('progress, [role="progressbar"]')).some(isVisible);
  const clickable = (el) => (el && (el.closest('button, [role="button"]') || el)) || null;
  // Plain page click (no Chrome "debugging" bar, so WhatsApp's menus don't close on us).
  const pageClick = (el) => {
    const rect = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window,
                 clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", at));
    el.dispatchEvent(new MouseEvent("mousedown", at));
    el.dispatchEvent(new PointerEvent("pointerup", at));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.click();
  };
  const realClick = async (el) => {
    el.scrollIntoView({ block: "center" });
    await sleep(60);
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) { // nothing on screen to aim at
      debugLog(`plain click (no size on screen): ${el.tagName.toLowerCase()}`);
      el.click();
      return;
    }
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
  const same = (a, b) => (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();

  // ---------- steps ----------
  const waitForWhatsappLoaded = async () => {
    debugLog("waiting for WhatsApp to load");
    const end = Date.now() + 180000;
    let isReady = false;
    while (Date.now() < end) {
      if (isVisible(document.querySelector("#pane-side")) && !isLoadingShown()) {
        isReady = true;
        break;
      }
      const text = document.body ? document.body.innerText : "";
      // "WhatsApp is open in another window" -> take it over here.
      if (/open in another window/i.test(text)) {
        const useHere = Array.from(document.querySelectorAll('button, [role="button"]'))
          .find((el) => isVisible(el) && /^\s*use here\s*$/i.test(el.innerText || ""));
        if (useHere) {
          debugLog("WhatsApp was open in another window, clicking Use here");
          pageClick(useHere);
          await sleep(3000);
          continue;
        }
      }
      // Logged out: no point waiting for a QR code to scan itself.
      if (document.querySelector('canvas[aria-label*="scan" i], [data-ref] canvas') ||
          /scan (the )?qr code|log ?in(to)? (to )?whatsapp|link with phone number/i.test(text)) {
        throw new Error("WhatsApp Web is logged out. Scan the QR code in Chrome with your phone, then share again.");
      }
      await sleep(400);
    }
    if (!isReady) throw new Error("WhatsApp Web didn't finish loading within 3 minutes.");
    await sleep(300);
  };

  const chatHeader = () => document.querySelector("#main header") || document.querySelector("#main [data-testid*='header' i]");
  // True when the open chat's header names the group (any line of it, or any title attribute).
  const isChatOpen = () => {
    const header = chatHeader();
    if (!header) return false;
    const lines = (header.innerText || "").split("\n").map((line) => line.trim());
    const titles = Array.from(header.querySelectorAll("[title]")).map((el) => el.getAttribute("title"));
    return [...lines, ...titles].some((text) => same(text, group));
  };
  const describeHeader = () => {
    const header = chatHeader();
    return `main=${!!document.querySelector("#main")} header=${!!header} ` +
      `firstLine="${header ? (header.innerText || "").split("\n")[0].slice(0, 60) : ""}"`;
  };

  const findChatRow = () => Array.from(document.querySelectorAll("#pane-side span[title], #side span[title]"))
    .find((span) => isVisible(span) && same(span.getAttribute("title"), group));

  const openChat = async () => {
    if (isChatOpen()) {
      debugLog(`chat "${group}" already open`);
      return;
    }
    let row = findChatRow();
    if (!row) {
      debugLog(`"${group}" not in the visible list, searching`);
      const searchBox = Array.from(document.querySelectorAll(
        '#side [contenteditable="true"], #side input[type="text"], [aria-label^="Search" i][contenteditable="true"]'))
        .find(isVisible);
      if (!searchBox) throw new Error("Couldn't find WhatsApp's search box.");
      await realClick(searchBox);
      await sleep(150);
      await chrome.runtime.sendMessage({ type: "realType", text: group, pressEnter: false });
      row = await waitFor(findChatRow, 20000);
      if (!row) throw new Error(`Couldn't find a chat called "${group}".`);
      await sleep(200);
    }
    debugLog(`opening chat "${group}"`);
    await realClick(row); // the name itself: always inside the clickable chat row
    if (!(await waitFor(isChatOpen, 20000))) {
      debugLog(`chat check failed: ${describeHeader()}`);
      throw new Error(`Clicked "${group}", but the chat didn't open.`);
    }
    debugLog(`chat "${group}" is open`);
  };

  const waitForMessagesLoaded = async () => {
    debugLog("waiting for the chat's messages to load");
    const main = document.querySelector("#main");
    await waitFor(() => main.querySelector('[role="row"], [data-id], .message-in, .message-out'), 30000);
    await waitFor(() => !isLoadingShown(main), 60000, 300);
    await waitForQuiet(main, 600, 3000); // a short settle only: a busy group is never quiet
  };

  const findCaptionBox = () => {
    const boxes = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
      .filter((el) => isVisible(el) && !el.closest("#side") && !el.closest("#main footer"));
    return boxes.find((el) => /caption/i.test(`${el.getAttribute("aria-label")} ${el.getAttribute("aria-placeholder")}`))
      || boxes[0] || null;
  };

  // The files for this share: the renamed CSV, then the TEMS picture (sent as its own photo).
  const getShareFiles = async () => {
    const reply = await chrome.runtime.sendMessage({ type: "getFiles" });
    if (!reply || !reply.files || !reply.files.length) {
      throw new Error((reply && reply.error) || "Couldn't get the CSV from the app.");
    }
    return reply.files;
  };
  const typeOf = (name) => ({ csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" })[
    (name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";
  // Our own message in the open chat carrying this file (sent, or still on its clock). Only
  // outgoing messages count - someone else posting the same name doesn't.
  // Matched on the file's name, or on the WO in it ("<date>_<id>_Cloud WO - <WO>.csv"): WhatsApp can
  // shorten a long file name in the chat, but the WO is also in the caption under it.
  // Our own messages in the open chat. WhatsApp no longer marks them (no "true_" ids, no
  // message-out class); only ours carry a delivery state - labelled " Sent " / " Delivered " /
  // " Read " / " Pending " (with spaces) or "You:", or a tick / clock icon.
  const ownStates = /^(you:?|sent|delivered|read|seen|pending)$/i;
  const ownIcon = /^(msg-|status-)?(dbl)?check|msg-time|status-time|clock/i;
  const isMine = (el) => Array.from(el.querySelectorAll("[aria-label], [data-icon]")).some((n) =>
    ownStates.test((n.getAttribute("aria-label") || "").trim()) || ownIcon.test(n.getAttribute("data-icon") || ""));
  const myMessages = () => {
    const main = document.querySelector("#main");
    if (!main) return [];
    const old = Array.from(main.querySelectorAll('[data-id^="true_"], .message-out'));
    if (old.length) return old;
    return Array.from(main.querySelectorAll("[data-id]")).filter(isMine);
  };
  const sentInChat = (fileName) => {
    const base = (fileName || "").replace(/\.[a-z0-9]+$/i, "");
    const wants = [base, base.split(" - ").pop()].map((text) => text.replace(/\s+/g, "").toLowerCase()).filter((w) => w.length >= 8);
    const main = document.querySelector("#main");
    if (!main || !wants.length) return false;
    return myMessages().some((el) => {
      const texts = [el.innerText || "", ...Array.from(el.querySelectorAll("[title]")).map((t) => t.getAttribute("title"))];
      return texts.some((text) => { const squashed = text.replace(/\s+/g, "").toLowerCase(); return wants.some((w) => squashed.includes(w)); });
    });
  };
  // When the check above doesn't find a message we just sent: what the chat's last messages look
  // like (their markers and length only, no text), to fix the check.
  const describeLastMessages = () => {
    const main = document.querySelector("#main");
    const rows = main ? Array.from(main.querySelectorAll("[data-id]")).slice(-3) : [];
    return rows.map((el) => `${(el.getAttribute("data-id") || "").slice(0, 6)}${isMine(el) ? "/mine" : ""}` +
      ` text=${(el.innerText || "").length} icons=${Array.from(el.querySelectorAll("[data-icon]")).map((i) => i.getAttribute("data-icon")).slice(0, 4).join(",")}`).join(" | ") || "no [data-id] rows";
  };

  const isPicture = (name) => typeOf(name).startsWith("image/");
  // The attach menu's options: Document sends a file as a file; Photos & videos sends a picture
  // as a picture (shown in the chat, not as a PNG download).
  const attachOptions = {
    document: { label: "Document", pattern: /^\s*document\s*$/i },
    photos: { label: "Photos & videos", pattern: /^\s*photos?\s*(&|and)\s*videos?\s*$/i },
  };
  // Attaches the files through one attach-menu option and returns the preview's caption box.
  // WhatsApp's preview Send button says how many files it holds ("Send 2 selected").
  const previewCount = () => {
    const button = findSendButton();
    const label = button ? `${button.getAttribute("aria-label") || ""} ${button.querySelector("[aria-label]")?.getAttribute("aria-label") || ""}` : "";
    const match = label.match(/(\d+)\s+selected/i);
    return match ? Number(match[1]) : null;
  };
  const attachFiles = async (files, optionKey, isRetry = false) => {
    if (document.hidden) debugLog("the WhatsApp tab is hidden (another window over Chrome?) - Chrome slows it down");
    const option = attachOptions[optionKey];
    const file = files[0];
    const transfer = new DataTransfer();
    for (const f of files) {
      transfer.items.add(new File([base64ToBytes(f.data)], f.name, { type: typeOf(f.name), lastModified: f.lastModified }));
    }

    // Leave the CSV in a hidden carrier box, and catch WhatsApp's "open the file picker" so it
    // gets the carrier's file instead of showing Windows' dialog.
    document.getElementById("kaam-file-carrier")?.remove();
    const carrier = document.createElement("input");
    carrier.type = "file";
    carrier.id = "kaam-file-carrier";
    carrier.style.display = "none";
    carrier.files = transfer.files;
    document.body.appendChild(carrier);
    if (!(await chrome.runtime.sendMessage({ type: "whatsappHookFilePicker" }))) {
      carrier.remove();
      throw new Error("Couldn't prepare WhatsApp for the file.");
    }

    const attachIcon = document.querySelector(
      '#main footer [data-icon="plus-rounded"], #main footer [data-icon="plus"], #main footer [data-icon="clip"], ' +
      '#main footer [data-icon="attach-menu-plus"], #main footer [aria-label="Attach" i], #main footer [title="Attach" i]');
    const hasSize = (el) => { const rect = el.getBoundingClientRect(); return rect.width > 4 && rect.height > 4; };
    // The option's on-screen text in the attach menu, then the row you'd click.
    const findDocumentItem = () => {
      const label = Array.from(document.querySelectorAll("span, div, li, button"))
        .filter((el) => hasSize(el) && option.pattern.test(el.innerText || ""))
        .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height
                      - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
      if (!label) return null;
      const row = label.closest('li, [role="button"], [role="menuitem"], button');
      return row && hasSize(row) ? row : label;
    };
    // Plain page clicks here, not real ones: a real click shows Chrome's "debugging" bar for a
    // moment, the page resizes, and WhatsApp closes its menu before we can pick Document.
    if (!findDocumentItem()) { // the menu may still be open from before; + would close it
      if (!attachIcon) {
        carrier.remove();
        throw new Error("Couldn't find WhatsApp's attach (+) button.");
      }
      debugLog("opening the attach menu");
      pageClick(clickable(attachIcon));
    }
    const documentItem = await waitFor(findDocumentItem, 8000, 100);
    if (!documentItem) {
      carrier.remove();
      throw new Error(`Opened the attach menu, but its ${option.label} option wasn't found.`);
    }
    await sleep(150); // let the menu finish opening
    const docRect = documentItem.getBoundingClientRect();
    debugLog(`choosing ${option.label} (${documentItem.tagName.toLowerCase()} at ${Math.round(docRect.left)},${Math.round(docRect.top)})`);
    pageClick(documentItem);
    if (!(await waitFor(() => !document.getElementById("kaam-file-carrier"), 8000, 100))) {
      // Structure only (tags, roles, positions, file boxes) - no message text.
      const describe = (el) => {
        const rect = el.getBoundingClientRect();
        return `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}` +
          `@${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
      };
      const chain = [];
      for (let el = documentItem; el && chain.length < 6; el = el.parentElement) chain.push(describe(el));
      const fileBoxes = Array.from(document.querySelectorAll('input[type="file"]'))
        .map((input) => `${input.id || "?"}:${input.accept || "any"}`).join(" ");
      debugLog(`${option.label} option: ${chain.join(" < ")}`);
      debugLog(`file boxes now: ${fileBoxes || "none"} | menu still open: ${!!findDocumentItem()}`);
      carrier.remove();
      throw new Error(`WhatsApp didn't take ${file.name} from the ${option.label} option.`);
    }
    debugLog(`attached ${files.map((f) => f.name).join(" + ")} as ${option.label}`);

    const captionBox = await waitFor(findCaptionBox, 30000, 150);
    if (!captionBox) throw new Error(`Attached ${file.name}, but WhatsApp's preview didn't open.`);
    await waitFor(findSendButton, 15000, 150);  // the preview is ready once its Send button shows
    await sleep(150);
    // Never send files left over in WhatsApp's preview from before along with this one.
    const count = previewCount();
    if (count !== null && count > files.length) {
      debugLog(`the preview holds ${count} files, not ${files.length} - discarding it${isRetry ? "" : " and attaching again"}`);
      await closeLeftoverPreview(true);
      if (findCaptionBox()) throw new Error(`WhatsApp's preview had ${count} files in it and wouldn't close - nothing sent. Close it in WhatsApp.`);
      if (isRetry) throw new Error(`WhatsApp's preview had ${count} files in it (left over from before), not just ${file.name} - nothing sent.`);
      return attachFiles(files, optionKey, true);
    }
    return { captionBox, fileName: file.name };
  };

  const typeCaption = async (captionBox) => {
    debugLog("typing the report as the caption");
    await realClick(captionBox);
    await sleep(100);
    const typed = await chrome.runtime.sendMessage({ type: "realTypeLines", lines: caption.split("\n") });
    if (!typed) throw new Error("Couldn't type the caption.");
    await sleep(250);
  };

  // The preview's send button. WhatsApp renames its icons now and then, so match loosely.
  const findSendButton = () => Array.from(document.querySelectorAll(
    '[data-icon*="send" i], [aria-label*="send" i], [title*="send" i]'))
    .filter((el) => isVisible(el) && el.getBoundingClientRect().width > 4 &&
      !el.closest("#side") && !el.closest("#main footer") &&
      !/send (document|message to)|resend/i.test(el.getAttribute("aria-label") || ""))
    .map(clickable)[0] || null;

  const pressSend = async (captionBox, fileName) => {
    if (!(await chrome.runtime.sendMessage({ type: "stillWanted" }))) {
      throw new Error("Stopped from the app - Send was not pressed.");
    }
    const sendButton = findSendButton();
    if (sendButton) {
      const icon = sendButton.querySelector("[data-icon]");
      debugLog(`pressing Send (button: ${icon ? icon.getAttribute("data-icon") : sendButton.getAttribute("aria-label") || "?"})`);
      pageClick(sendButton);
      await waitFor(() => !findCaptionBox(), 6000, 100);
    }
    // No button, or the click didn't take (preview still open, so nothing was sent):
    // Enter in the caption box is WhatsApp's own "send" for the preview.
    if (findCaptionBox()) {
      debugLog(sendButton ? "the Send click didn't take, pressing Enter in the caption box"
                          : "no Send button found, pressing Enter in the caption box");
      await realClick(findCaptionBox() || captionBox);
      await sleep(100);
      await chrome.runtime.sendMessage({ type: "realType", text: "", pressEnter: true });
    }
    // Sent once the preview closes - or once our message with the file shows in the chat (a busy
    // group can keep the preview busy for a moment).
    if (!(await waitFor(() => !findCaptionBox() || sentInChat(fileName), 30000, 100))) {
      throw new Error("Pressed Send, but the preview didn't close. Check WhatsApp.");
    }
    debugLog(sentInChat(fileName) ? "sent - the message is in the chat" : "sent - the preview closed");
    if (fileName && !(await waitFor(() => sentInChat(fileName), 5000, 150))) {  // in the chat (a later check-first sees it)
      debugLog(`sent, but not found in the chat by name yet: ${describeLastMessages()}`);
    }
    await sleep(200);
  };

  // On a retry, close the file preview a failed try may have left open (only then, so a
  // draft from an earlier share is never touched).
  const closeLeftoverPreview = async (force = false) => {
    if ((attempt < 2 && !force) || !findCaptionBox()) return;
    debugLog(`try ${attempt}: closing the preview the failed try left open`);
    const closeButton = Array.from(document.querySelectorAll('[data-icon="x"], [data-icon="close"], [aria-label="Close" i]'))
      .find((el) => isVisible(el) && !el.closest("#side"));
    if (closeButton) {
      pageClick(clickable(closeButton));
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    }
    await waitFor(() => {
      const discard = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find((el) => isVisible(el) && /^\s*discard\s*$/i.test(el.innerText || ""));
      if (discard) pageClick(discard); // "Discard unsent message?"
      return !findCaptionBox();
    }, 8000);
    await sleep(300);
  };

  // ---------- a plain text message (no file), e.g. "<WO> - Done" ----------
  const squashText = (text) => (text || "").replace(/\s+/g, "").toLowerCase();
  // Our own message in the open chat with exactly this text in it (someone else's doesn't count).
  const textInChat = (text) => {
    const want = squashText(text);
    const main = document.querySelector("#main");
    if (!main || !want) return false;
    return myMessages().some((el) => squashText(el.innerText).includes(want));
  };
  const composeBox = () => Array.from(document.querySelectorAll('#main footer div[contenteditable="true"]')).find(isVisible) || null;
  const sendText = async (text) => {
    if (checkFirst && textInChat(text)) {
      debugLog("that message is already in the chat (sent by us) - not sending it again");
      finish({ ok: true, sent: true, alreadySent: true, summary: `Already in "${group}": ${text.split("\n")[0]}${text.includes("\n") ? " …" : ""}` });
      return;
    }
    const box = composeBox();
    if (!box) throw new Error("Couldn't find WhatsApp's message box.");
    if ((box.innerText || "").trim()) throw new Error(`"${group}" has an unsent draft in its message box - send or clear it first.`);
    debugLog("typing the message");
    await realClick(box);
    await sleep(100);
    if (!(await chrome.runtime.sendMessage({ type: "realTypeLines", lines: text.split("\n") }))) throw new Error("Couldn't type the message.");
    await sleep(200);
    if (!send) {
      finish({ ok: true, sent: false, summary: `Typed in "${group}" - press Send.` });
      return;
    }
    if (!(await chrome.runtime.sendMessage({ type: "stillWanted" }))) throw new Error("Stopped from the app - Send was not pressed.");
    debugLog("pressing Enter to send");
    await chrome.runtime.sendMessage({ type: "realType", text: "", pressEnter: true });
    const lastLine = text.split("\n").pop();
    if (!(await waitFor(() => textInChat(lastLine) || !(composeBox()?.innerText || "").trim(), 20000))) {
      throw new Error("Pressed Send, but the message is still in the box. Check WhatsApp.");
    }
    await waitFor(() => textInChat(lastLine), 5000, 150);
    debugLog("sent");
    await sleep(200);
    finish({ ok: true, sent: true, summary: `Sent to "${group}": ${text.split("\n").length > 1 ? `${text.split("\n").length} lines` : text}` });
  };

  // ---------- inspect (sends nothing): how the open chat marks messages, to keep the checks right ----------
  const inspectChat = (lookFor) => {
    const main = document.querySelector("#main");
    if (!main) return { error: "no #main" };
    const short = (text) => String(text || "").replace(/\s+/g, " ").slice(0, 60);
    const rows = Array.from(main.querySelectorAll('[role="row"]'));
    const byTop = rows.map((el) => ({ el, top: el.getBoundingClientRect().top })).sort((a, b) => a.top - b.top).slice(-6);
    const want = squashText(lookFor.split(",")[0]);
    return {
      mine: myMessages().length,
      found: Object.fromEntries(lookFor.split(",").map((w) => w.trim()).filter(Boolean).map((w) => [w, sentInChat(`x - ${w}.csv`)])),
      rows: rows.length, dataIds: main.querySelectorAll("[data-id]").length,
      firstDataIds: Array.from(main.querySelectorAll("[data-id]")).slice(0, 2).map((el) => short(el.getAttribute("data-id"))),
      lastDataIds: Array.from(main.querySelectorAll("[data-id]")).slice(-2).map((el) => short(el.getAttribute("data-id"))),
      messageOut: main.querySelectorAll(".message-out").length, messageIn: main.querySelectorAll(".message-in").length,
      last: byTop.map(({ el, top }) => {
        const all = [el, ...el.querySelectorAll("*")];
        const ids = all.map((n) => n.getAttribute && n.getAttribute("data-id")).filter(Boolean);
        return {
          top: Math.round(top), textLength: (el.innerText || "").length, hasLookFor: !!want && squashText(el.innerText).includes(want),
          dataIds: ids.slice(0, 2).map(short),
          classes: Array.from(new Set(all.flatMap((n) => String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || "").split(/\s+/))
            .filter((c) => /message|out|in$|tail|bubble|status|own|self/i.test(c)))).slice(0, 12),
          icons: Array.from(new Set(all.map((n) => n.getAttribute && n.getAttribute("data-icon")).filter(Boolean))).slice(0, 10),
          ariaLabels: Array.from(new Set(all.map((n) => n.getAttribute && n.getAttribute("aria-label")).filter(Boolean).map(short))).slice(0, 6),
          testIds: Array.from(new Set(all.map((n) => n.getAttribute && n.getAttribute("data-testid")).filter(Boolean))).slice(0, 8),
          prePlain: short((el.querySelector("[data-pre-plain-text]") || {}).getAttribute?.("data-pre-plain-text")),
        };
      }),
    };
  };

  // ---------- a batch (End Tickets): every WO in this one chat, back to back ----------
  // The app gets each WO's result as it goes (so it's saved at once), and the final list at the end.
  const shareBatch = async () => {
    const reply = await chrome.runtime.sendMessage({ type: "getFiles" });
    if (!reply || !reply.files || !reply.items) throw new Error((reply && reply.error) || "Couldn't get the files from the app.");
    const results = [];
    const report = () => chrome.runtime.sendMessage({ type: "jobProgress", progress: { items: results } }).catch(() => {});
    for (const item of reply.items) {
      stopIfReplaced();
      if (!(await chrome.runtime.sendMessage({ type: "stillWanted" }))) {
        results.push({ wo: item.wo, ok: false, error: "Stopped from the app - not sent." });
        break;
      }
      const started = Date.now();
      const itemFiles = item.files.map((n) => reply.files[n]);
      const file = itemFiles.find((f) => !isPicture(f.name)) || itemFiles[0];
      const pictures = itemFiles.filter((f) => f !== file && isPicture(f.name));
      let csvSent = false;
      try {
        if (item.checkFirst !== false && sentInChat(file.name)) {  // a WO already in the chat isn't sent twice
          debugLog(`${file.name} is already in the chat - not sending it again`);
          results.push({ wo: item.wo, ok: true, sent: true, alreadySent: true, seconds: 0,
                         summary: `Already in "${group}": ${file.name} - not sent again.` });
          await report();
          continue;
        }
        caption = item.caption || "";
        const { captionBox, fileName } = await attachFiles([file], "document");
        await typeCaption(captionBox);
        await pressSend(captionBox, fileName);
        csvSent = true;
        if (pictures.length) {
          await sleep(300);
          await pressSend((await attachFiles(pictures, "photos")).captionBox, null);
        }
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        debugLog(`${item.wo}: sent in ${seconds}s`);
        results.push({ wo: item.wo, ok: true, sent: true, seconds,
                       summary: `Sent to "${group}": ${fileName}${pictures.length ? " + the TEMS picture" : ""} with the report.` });
      } catch (error) {
        if (error.message === replacedError) throw error;
        results.push({ wo: item.wo, ok: false, sent: csvSent, error: csvSent
          ? `Pressed Send on the CSV, but the TEMS picture didn't go (${error.message}). Send the picture yourself.`
          : error.message });
        if (/logged out/i.test(error.message)) { await report(); break; }
        await closeLeftoverPreview(true);  // a half-done preview mustn't go out with the next WO
      }
      await report();
    }
    const sentCount = results.filter((r) => r.ok).length;
    finish({ ok: results.length === reply.items.length && results.every((r) => r.ok), sent: sentCount > 0, items: results,
             summary: `"${group}": ${sentCount} of ${reply.items.length} shared.` });
  };

  // ---------- run ----------
  try {
    if (attempt > 1) debugLog(`try ${attempt}`);
    await waitForWhatsappLoaded();
    await closeLeftoverPreview();
    await openChat();
    await waitForMessagesLoaded();
    if (job.data.text) { await sendText(job.data.text); return; }
    if (job.data.batch) { await shareBatch(); return; }
    if (job.data.inspect) { finish({ ok: true, summary: "inspected", inspect: inspectChat(job.data.inspect) }); return; }
    const files = await getShareFiles();
    const file = files.find((f) => !isPicture(f.name)) || files[0];
    const pictures = files.filter((f) => f !== file && isPicture(f.name));
    const withPicture = pictures.length ? " + the TEMS picture" : "";
    if (checkFirst && sentInChat(file.name)) {
      debugLog(`${file.name} is already in the chat (sent by us) - not sending it again`);
      finish({ ok: true, sent: true, alreadySent: true,
               summary: `Already in "${group}" on WhatsApp: ${file.name} - not sent again.` });
      return;
    }
    // Message 1: the CSV with the report as its caption. Message 2: the picture, as a photo.
    const { captionBox, fileName } = await attachFiles([file], "document");
    await typeCaption(captionBox);
    const attachPictures = async () => {
      await sleep(300); // the CSV just went out
      return (await attachFiles(pictures, "photos")).captionBox;
    };
    // The CSV is out by now: a retry would skip this share, so say so instead (not retried).
    const pictureFailed = (error) => {
      if (error.message === replacedError) throw error;
      throw new Error(`Pressed Send on the CSV, but the TEMS picture didn't go (${error.message}). Send the picture yourself.`);
    };
    if (send) {
      await pressSend(captionBox, fileName);
      if (pictures.length) {
        try { await pressSend(await attachPictures(), null); } catch (error) { pictureFailed(error); }
      }
      finish({ ok: true, sent: true, summary: `Sent to "${group}" on WhatsApp: ${fileName}${withPicture} with the report.` });
    } else if (!pictures.length) {
      finish({ ok: true, sent: false,
               summary: `Ready in WhatsApp "${group}": ${fileName} attached and the report typed. Press Send.` });
    } else {
      // You press Send on the CSV; then the picture is attached for you to send too.
      debugLog("waiting for you to send the CSV, then the picture is attached");
      if (!(await waitFor(() => sentInChat(fileName), 4 * 60000, 1000))) {
        finish({ ok: true, sent: false,
                 summary: `Ready in WhatsApp "${group}": ${fileName} attached and the report typed. Press Send, then send the TEMS picture yourself.` });
        return;
      }
      await attachPictures();
      finish({ ok: true, sent: false,
               summary: `"${group}": you sent ${fileName}; the TEMS picture is attached. Press Send.` });
    }
  } catch (error) {
    if (error.message === replacedError) {
      debugLog("stopped: a newer share took over");
      return; // the newer share reports for itself
    }
    finish({ error: error.message });
  }
})();
