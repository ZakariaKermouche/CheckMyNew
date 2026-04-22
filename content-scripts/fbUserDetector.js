// content-scripts/fbUserDetector.js

let userIdDetected = false;
let injectAttempts = 0;
const MAX_INJECT_ATTEMPTS = 10;
const INJECT_RETRY_MS = 2000;

function safeSendMessage(payload) {
  try {
    const maybePromise = chrome.runtime.sendMessage(payload);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch (_) {}
}

// Listen for messages from MAIN world
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== "CMN") return;

  if (event.data.type === "USER_ID") {
    userIdDetected = true;
    safeSendMessage({
      type: "userIdDetected",
      userId: event.data.userId,
    });
  }
});

function requestInjection() {
  if (userIdDetected) return;
  if (injectAttempts >= MAX_INJECT_ATTEMPTS) return;
  injectAttempts += 1;
  safeSendMessage({ type: "injectUserDetector" });
}

// Ask service worker to inject MAIN-world detector (retry a few times)
requestInjection();
const retryTimer = setInterval(() => {
  if (userIdDetected || injectAttempts >= MAX_INJECT_ATTEMPTS) {
    clearInterval(retryTimer);
    return;
  }
  requestInjection();
}, INJECT_RETRY_MS);
window.addEventListener("CMN_UI_DETECTED", (e) => {
  const { version, mobile } = e.detail || {};
  if (!version) return;

  safeSendMessage({
    type: "ui-detection",
    version,
    mobile,
  });
});
