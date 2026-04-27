// =============================
//  CheckMyNews - MV3 Service Worker
//  CLEAN VERSION (NO dynamic import())
// =============================

// -------------------------------------
// 1. Static imports (Required in MV3)
// -------------------------------------
import * as ads from "./ads.js";
import * as explanations from "./explanations.js";
import * as preferences from "./preferences.js";
import * as news from "./news.js";
import * as consent from "./consent.js";
import * as user from "./userIdentification.js";
import * as iface from "./detectors.js";

import { replaceUserIdEmail } from "./utils/errors.js";
import { lsGet, lsSet } from "./utils/storage.js";
import "../third-party/sha512.min.js";

// -------------------------------------
// 2. Global state
// -------------------------------------
const state = {
  CURRENT_USER_ID: null,
  PROLIFIC_ID:null,
  LOGGED_IN: false,
  FACEBOOK_UI_VERSION: null,
  FACEBOOK_MOBILE: false,
  initialized: false,
  lastConsentPromptAt: 0,
};

const CONSENT_NOTIFICATION_ID = "cmn_consent_required";
const CONSENT_PROMPT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// -------------------------------------
// 3. Backend URLs
// -------------------------------------
const HOST_SERVER = "https://adanalystplus.lix.polytechnique.fr/";

const URLS_SERVER = {
  registerAd: HOST_SERVER + "register_ad",
  registerClickedAd: HOST_SERVER + "register_clickedad",
  registerExplanation: HOST_SERVER + "register_explanation",
  registerInterests: HOST_SERVER + "register_interests",
  registerAdvertisers: HOST_SERVER + "register_advertisers",
  registerConsent: HOST_SERVER + "register_consent",
  getConsent: HOST_SERVER + "get_consent",
  registerEmail: HOST_SERVER + "register_email",
  registerLanguage: HOST_SERVER + "register_language",
  updateSurveysNumber: HOST_SERVER + "surveys_number",
  registerStillAlive: HOST_SERVER + "register_still_alive",
  storeExtensionNameAndVersion:
    HOST_SERVER + "store_extension_name_and_version",
  newInterfaceDetected: HOST_SERVER + "new_interface_detected",
  updateAdClickEvents: HOST_SERVER + "update_ad_event",
  updateMouseMoveEvents: HOST_SERVER + "update_mousemove_event",
  updateAdVisibilityEvents: HOST_SERVER + "update_advisibility_event",
  updatePosstVisibilityEvents: HOST_SERVER + "update_postvisibility_event",
  registerProlificId: HOST_SERVER + "storeprolificid",


};


// -------------------------------------
// Get prolific ID if exists
// -------------------------------------


async function extractProlificIdFromUrl() {
 try {
 // Check if we already have a prolific PID stored
 const stored = await lsGet("PROLIFIC_PID");
 if (stored) {
 state.PROLIFIC_PID = stored;
 return;
 }

 // Try to get from chrome.storage.local (set by install.html)
 const localData = await chrome.storage.local.get("PROLIFIC_PID");
 if (localData.PROLIFIC_PID) {
 state.PROLIFIC_PID = localData.PROLIFIC_PID;
 await lsSet("PROLIFIC_PID", localData.PROLIFIC_PID);
 console.log('Extracted prolificPid from chrome.storage.local:', localData.PROLIFIC_PID);
 return;
 }

 // Scan all open tabs for a URL containing ?PROLIFIC_PID=xxx
 const tabs = await chrome.tabs.query({});
 for (const tab of tabs) {
 if (!tab.url) continue;
 const url = new URL(tab.url);
 const prolificPid = url.searchParams.get("PROLIFIC_PID");
 if (prolificPid) {
 state.PROLIFIC_PID = prolificPid;
 await lsSet("PROLIFIC_PID", prolificPid);
 console.log('Extracted prolificPid from tab URL:', prolificPid);
 return;
 }
 }

 console.log('No PROLIFIC_PID found in storage or open tabs.');
 } catch (e) {
 console.error('Error extracting prolificPid from URL:', e);
 }
}



async function postJSON(url, bodyObj) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}


// -------------------------------------
// Send prolific ID
// -------------------------------------

async function sendProlificId() {
 try {
 if (!state.PROLIFIC_PID) return;
 const payload = {
 prolific_id: state.PROLIFIC_PID,
 user_id: state.CURRENT_USER_ID, 
 timestamp: Date.now(),
 };
 console.log(payload)
 await postJSON(URLS_SERVER.registerProlificId, hashPayload(payload));
 } catch (e) {
 console.error('Error sending prolificId:', e);
 }
}


function isBackendFailure(payload) {
  if (!payload || typeof payload !== "object") return true;
  if (payload?.ok === false) return true;
  const statusRaw = payload?.status;
  if (typeof statusRaw === "string") {
    const status = statusRaw.toLowerCase();
    return status === "failure" || status === "error";
  }
  // Some endpoints return objects without `status` (e.g., { ok: true }).
  return false;
}

async function postJSONWithRetry(
  url,
  bodyObj,
  { retries = 3, requireSuccessStatus = true } = {}
) {
  let lastOut = null;
  let lastErr = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      const out = await postJSON(url, bodyObj);
      lastOut = out;
      if (!requireSuccessStatus || !isBackendFailure(out)) {
        return out;
      }
      lastErr = new Error(out?.reason || "backend_failure");
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return lastOut || {};
}

const hashFn =
  typeof globalThis?.sha512 === "function"
    ? globalThis.sha512
    : globalThis?.sha512?.sha512?.bind(globalThis.sha512) ||
      globalThis?.sha512?.sha512_384?.bind(globalThis.sha512);

function hashPayload(payload) {
  return replaceUserIdEmail(payload, hashFn);
}

// -------------------------------------
// 4. Offscreen document
// -------------------------------------
async function ensureOffscreen() {
  if (!chrome.offscreen) {
    return;
  }

  const exists = await chrome.offscreen.hasDocument();
  if (exists) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Parse explanation HTML and images.",
  });
}

// -------------------------------------
// 5. Alarms
// -------------------------------------
const HEARTBEAT = "cmn_heartbeat";
const EXPLAIN = "cmn_explanations";

function initAlarms() {
  chrome.alarms.create(HEARTBEAT, { periodInMinutes: 5 });
  chrome.alarms.create(EXPLAIN, { periodInMinutes: 5 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT) {
    await consent.refreshConsent(state, URLS_SERVER);
    await preferences.crawlPreferences(state, URLS_SERVER, { force: false });
    await sendStillAlive();
    await maybeSendSurveysNumber();
    return;
  }

  if (alarm.name === EXPLAIN) {
    await explanations.processExplanationsQueue(state, URLS_SERVER);
    return;
  }
});

// -------------------------------------
// 6. Initialization
// -------------------------------------
async function init() {
  if (state.initialized) return;
  state.initialized = true;

  await ensureOffscreen();
  await extractProlificIdFromUrl();
  await user.initUserIdentification(state, URLS_SERVER);
  await syncExtensionIcon();
  await consent.initConsentSystem(state, URLS_SERVER);
  await syncConsentIfNeeded();
  await explanations.initExplanationsSystem(state, URLS_SERVER);
  await preferences.initPreferencesSystem(state, URLS_SERVER);
  await news.initNewsSystem(state, URLS_SERVER);
  await iface.initDetectors(state, URLS_SERVER);
  await ensureConsentStatus({ forceServerRefresh: true, promptUser: true });
  await sendExtensionInfo();
  await sendLanguage();
  await sendProlificId();

  initAlarms();
}

init();
globalThis.__CMN_STATE__ = state;

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab?.url || "";
  if (!url.includes("facebook.com")) return;
  await ensureConsentStatus({ forceServerRefresh: false, promptUser: true });
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId !== CONSENT_NOTIFICATION_ID) return;
  await consent.openConsentPage();
});

// -------------------------------------
// 7. Message routing (NO dynamic imports)
// -------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Let offscreen document requests be handled by the offscreen listener.
  if (message && message._offscreen) {
    return false;
  }

  (async () => {
    switch (message.type) {
      // ---------------------------
      // ADS
      // ---------------------------
      case "frontAd":
        console.log("[CMN] frontAd message received:", {
          messageType: message.type,
          hasAdId: !!message.adId,
          userId: state.CURRENT_USER_ID,
          timestamp: Date.now(),
        });
        
        try {
          console.log("[CMN] Processing frontAd with payload:", message);
          await ads.handleFrontAd(state, URLS_SERVER, message, sendResponse);
          console.log("[CMN] frontAd processed successfully");
        } catch (e) {
          console.error("[CMN] frontAd error:", e.message || e);
          throw e;
        }
        return;
      // case "frontAd":
        
        // console.log("frontAdd")
        // await ads.handleFrontAd(state, URLS_SERVER, message, sendResponse);
        // return;

      case "sideAd":
        await ads.handleSideAd(state, URLS_SERVER, message, sendResponse);
        return;

      case "clickedAds":
        await ads.handleClickedAds(state, URLS_SERVER, message, sendResponse);
        return;

      case "REGISTER_AD_BATCH":
        await ads.handleRegisterAdBatch(
          state,
          URLS_SERVER,
          message,
          sendResponse
        );
        return;

      case "POSTS_COLLECTED": {
        const payloads = Array.isArray(message.data)
          ? message.data
              .map((item) => item?.register_ad_payload || item)
              .filter(Boolean)
          : [];
        if (payloads.length === 0) {
          sendResponse({ ok: true, count: 0 });
          return;
        }
        await ads.handleRegisterAdBatch(
          state,
          URLS_SERVER,
          { payloads },
          sendResponse
        );
        return;
      }

      case "postVisibility": {
        if (!(await hasUserConsent())) {
          sendResponse({ ok: false, error: "no_consent" });
          return;
        }
        const payload = {
          html_post_id: message.postId,
          user_id: state.CURRENT_USER_ID,
          started_ts: message.started_ts,
          end_ts: message.end_ts,
        };
        try {
          const out = await postJSONWithRetry(
            URLS_SERVER.updatePosstVisibilityEvents,
            hashPayload(payload)
          );
          console.log("[CMN] postVisibility backend response:", out || null);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.toString() });
        }
        return;
      }
      case "adVisibility": {
        if (!(await hasUserConsent())) {
          sendResponse({ ok: false, error: "no_consent" });
          return;
        }
        const dbId = message.dbId || message.postId || message.adId || null;
        if (!dbId) {
          sendResponse({ ok: false, skipped: true, error: "missing_tracking_id" });
          return;
        }
        const payload = {
          dbId,
          id: dbId,
          html_ad_id: null,
          adanalyst_ad_id: null,
          user_id: state.CURRENT_USER_ID,
          started_ts: message.started_ts || null,
          end_ts: message.end_ts || null,
        };
        try {
          const out = await postJSONWithRetry(
            URLS_SERVER.updateAdVisibilityEvents,
            hashPayload(payload)
          );
          console.log("[CMN] adVisibility backend response:", out || null);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.toString() });
        }
        return;
      }
      case "mouseMove": {
        if (!(await hasUserConsent())) {
          sendResponse({ ok: false, error: "no_consent" });
          return;
        }
        const dbId = message.dbId || message.postId || message.adId || null;
        if (!dbId) {
          sendResponse({ ok: false, skipped: true, error: "missing_tracking_id" });
          return;
        }
        const payload = {
          dbId,
          id: dbId,
          html_ad_id: null,
          adanalyst_ad_id: null,
          user_id: state.CURRENT_USER_ID,
          timeElapsed: message.timeElapsed || 0,
          frames: JSON.stringify(message.frames || []),
          window: JSON.stringify(message.window || {}),
          lastAdPosition: JSON.stringify(message.lastAdPosition || {}),
          imagePosition: JSON.stringify(message.imagePosition || {}),
        };
        try {
          const out = await postJSONWithRetry(
            URLS_SERVER.updateMouseMoveEvents,
            hashPayload(payload)
          );
          console.log("[CMN] mouseMove backend response:", out || null);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.toString() });
        }
        return;
      }
      case "mouseClick": {
        if (!(await hasUserConsent())) {
          sendResponse({ ok: false, error: "no_consent" });
          return;
        }
        const dbId = message.dbId || null;
        const clickedUrl =
          typeof message.landingUrl === "string" && message.landingUrl.trim()
            ? message.landingUrl.trim()
            : null;
        const followedPageUrl =
          (message.eventType || "") === "FollowPage" ? clickedUrl : null;
        if (!dbId) {
          sendResponse({ ok: false, skipped: true, error: "missing_tracking_id" });
          return;
        }
        const payload = {
          ts: message.timestamp || Date.now(),
          dbId,
          id: dbId,
          html_ad_id: null,
          adanalyst_ad_id: null,
          user_id: state.CURRENT_USER_ID,
          type: message.eventType || "ImageClicked",
          landing_url: clickedUrl,
          followed_page_url: followedPageUrl,
          url: clickedUrl,
        };
        try {
          const out = await postJSONWithRetry(
            URLS_SERVER.updateAdClickEvents,
            hashPayload(payload),
            { requireSuccessStatus: false }
          );
          console.log("[CMN] mouseClick backend response:", out || null);
          sendResponse({ ok: true });
        } catch (e) {
          // Fallback endpoint for click/reaction telemetry when update_ad_event fails.
          const fallbackPayload = {
            user_id: state.CURRENT_USER_ID,
            dbId,
            id: dbId,
            post_id: message.postId || null,
            event_type: message.eventType || "ImageClicked",
            ts: message.timestamp || Date.now(),
            url: clickedUrl,
            landing_url: clickedUrl,
            followed_page_url: followedPageUrl,
          };
          try {
            const fallbackOut = await postJSONWithRetry(
              URLS_SERVER.registerClickedAd,
              hashPayload(fallbackPayload),
              { requireSuccessStatus: false }
            );
            console.log(
              "[CMN] mouseClick fallback(register_clickedad) response:",
              fallbackOut || null
            );
            sendResponse({ ok: true, fallback: true });
          } catch (fallbackErr) {
            sendResponse({ ok: false, error: fallbackErr.toString() });
          }
        }
        return;
      }

      case "queueExplanation":
        await explanations.queueExplanation(
          message.url,
          message.adId,
          message.meta || {}
        );
        if (message.processNow) {
          try {
            await explanations.processExplanationsQueue(state, URLS_SERVER);
          } catch (e) {}
        }
        sendResponse({ ok: true });
        return;

      case "registerExplanationData": {
        const result = await explanations.registerExplanationData(
          state,
          URLS_SERVER,
          message.payload || {}
        );
        sendResponse(result);
        return;
      }

      case "getAdsSummary":
        sendResponse(await ads.getAdsSummary());
        return;

      // ---------------------------
      // CONSENT
      // ---------------------------
      case "getConsentStatus": {
        const status = await consent.getConsentStatus(state, URLS_SERVER);
        updateExtensionIcon(status.consent === true);
        if (status.ok && status.currentUser) {
          status.currentUser = hashPayload({
            user_id: status.currentUser,
          }).user_id;
        }
        sendResponse(status);
        return;
      }

      case "registerConsent":
        {
          const result = await consent.registerConsent(
            state,
            URLS_SERVER,
            message.payload
          );
          if (result?.ok) {
            updateExtensionIcon(true);
            // After user ID hash is sent via registerConsent, also send prolificId mapping.
           try {
           await sendProlificId();
           } catch (e) {
           console.error('sendProlificId after registerConsent failed:', e);
           }
          }
          sendResponse(result);
        }
        return;

      case "openConsentPage":
        consent.openConsentPage();
        sendResponse({ ok: true });
        return;

      // ---------------------------
      // USER
      // ---------------------------
      case "getCurrentUserId":
        sendResponse({ userId: state.CURRENT_USER_ID });
        return;
      case "registerEmail": {
        if (!(await hasUserConsent())) {
          sendResponse({ ok: false, error: "no_consent" });
          return;
        }
        const payload = {
          user_id: state.CURRENT_USER_ID,
          email: message.email || "",
          timestamp: Date.now(),
        };
        try {
          await postJSON(URLS_SERVER.registerEmail, hashPayload(payload));
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.toString() });
        }
        return;
      }
      case "registerLanguage": {
        if (!(await hasUserConsent())) {
          sendResponse({ ok: false, error: "no_consent" });
          return;
        }
        const payload = {
          user_id: state.CURRENT_USER_ID,
          language: message.language || null,
          timestamp: Date.now(),
        };
        try {
          await postJSON(URLS_SERVER.registerLanguage, hashPayload(payload));
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.toString() });
        }
        return;
      }
      case "surveysNumber": {
        if (!(await hasUserConsent())) {
          sendResponse({ ok: false, error: "no_consent" });
          return;
        }
        const payload = {
          user_id: state.CURRENT_USER_ID,
          surveys_number: message.surveys_number || 0,
          timestamp: Date.now(),
        };
        try {
          await postJSON(URLS_SERVER.updateSurveysNumber, hashPayload(payload));
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.toString() });
        }
        return;
      }

      // ---------------------------
      // NEWS
      // ---------------------------
      case "getNewsActivity":
        sendResponse(await news.getNewsActivity());
        return;

      case "getNewsVisits":
        sendResponse(await news.getNewsVisits());
        return;

      // ---------------------------
      // UI DETECTION
      // ---------------------------
      case "ui-detection":
        await iface.handleUiDetectionMessage(message, state, URLS_SERVER);
        sendResponse({ ok: true });
        return;

      case "injectUserDetector": {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });

        if (!tab?.id) return;
        const url = tab.url || "";
        if (
          !url ||
          url.startsWith("chrome-extension://") ||
          url.startsWith("chrome://") ||
          url.startsWith("edge://")
        ) {
          sendResponse({ ok: false, error: "unsupported_tab" });
          return;
        }

        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: () => {
              try {
                if (window.requireLazy) {
                  window.requireLazy(
                    ["CurrentUserInitialData"],
                    function (data) {
                      if (data?.USER_ID) {
                        window.postMessage(
                          {
                            source: "CMN",
                            type: "USER_ID",
                            userId: String(data.USER_ID),
                          },
                          "*"
                        );
                      }
                    }
                  );
                }
              } catch (e) {}
            },
          });
        } catch (e) {
          const msg = String(e?.message || e || "");
          if (msg.includes("Frame with ID") && msg.includes("was removed")) {
            sendResponse({
              ok: false,
              transient: true,
              error: "frame_removed",
            });
            return;
          }
          throw e;
        }

        sendResponse({ ok: true });
        return;
      }
      // ---------------------------
      // USER ID DETECTED FROM CONTENT SCRIPT
      // ---------------------------
      case "userIdDetected": {
        const detectedId = message.userId;

        if (!detectedId) {
          sendResponse({ ok: false });
          return;
        }

        const unchanged = state.CURRENT_USER_ID === detectedId;
        if (unchanged) {
          sendResponse({ ok: true, unchanged: true });
          return;
        }
        await user.updateDetectedUserId(state, detectedId);

        // Re-initialize dependent systems
        await consent.initConsentSystem(state, URLS_SERVER);
        await preferences.initPreferencesSystem(state, URLS_SERVER);
        await explanations.initExplanationsSystem(state, URLS_SERVER);
        await news.initNewsSystem(state, URLS_SERVER);
        await ensureConsentStatus({
          forceServerRefresh: true,
          promptUser: true,
        });

        sendResponse({ ok: true, unchanged });
        return;
      }

      // ---------------------------
      // UNKNOWN MESSAGE
      // ---------------------------
      default:
        sendResponse({ ok: false, error: "UNKNOWN_MESSAGE" });
        return;
    }
  })().catch((e) => {
    const msg = String(e?.message || e || "unknown_error");
    try {
      if (msg.includes("Frame with ID") && msg.includes("was removed")) {
        sendResponse({ ok: false, transient: true, error: "frame_removed" });
        return;
      }
      sendResponse({ ok: false, error: msg });
    } catch (_) {}
  });

  return true;
});

// -------------------------------------
// 8. Installed event
// -------------------------------------
chrome.runtime.onInstalled.addListener(async (info) => {
  if (info.reason === "install") {
    await extractProlificIdFromUrl();
    chrome.tabs.create({ url: chrome.runtime.getURL("ui/new_consent.html") });
  }
});

async function sendExtensionInfo() {
  try {
    await syncConsentIfNeeded();
    if (!(await hasUserConsent())) return;
    const manifest = chrome.runtime.getManifest();
    const payload = {
      user_id: state.CURRENT_USER_ID,
      name: manifest?.name || "unknown",
      version: manifest?.version || "unknown",
      timestamp: Date.now(),
    };
    await postJSON(
      URLS_SERVER.storeExtensionNameAndVersion,
      hashPayload(payload)
    );
  } catch (e) {}
}

async function sendLanguage() {
  try {
    if (!(await hasUserConsent())) return;
    const language = chrome.i18n?.getUILanguage?.() || null;
    if (!language) return;
    const payload = {
      user_id: state.CURRENT_USER_ID,
      language,
      timestamp: Date.now(),
    };
    await postJSON(URLS_SERVER.registerLanguage, hashPayload(payload));
  } catch (e) {}
}

async function sendStillAlive() {
  try {
    if (!(await hasUserConsent())) return;
    if (!state.CURRENT_USER_ID) return;
    const payload = {
      user_id: state.CURRENT_USER_ID,
      timestamp: Date.now(),
    };
    await postJSON(URLS_SERVER.registerStillAlive, hashPayload(payload));
  } catch (e) {}
}

async function maybeSendSurveysNumber() {
  try {
    if (!(await hasUserConsent())) return;
    const { surveys_number } = await chrome.storage.local.get([
      "surveys_number",
    ]);
    if (typeof surveys_number !== "number") return;
    const payload = {
      user_id: state.CURRENT_USER_ID,
      surveys_number,
      timestamp: Date.now(),
    };
    await postJSON(URLS_SERVER.updateSurveysNumber, hashPayload(payload));
  } catch (e) {}
}

async function hasUserConsent() {
  try {
    if (!state.CURRENT_USER_ID) return false;
    return await consent.hasConsent(state.CURRENT_USER_ID);
  } catch (_) {
    return false;
  }
}

function updateExtensionIcon(consentGiven) {
  try {
    const path = consentGiven
      ? {
          16: "../media/enabled.png",
          48: "../media/enabled_48.png",
          128: "../media/enabled.png",
        }
      : {
          16: "../media/alert1.png",
          48: "../media/alert1.png",
          128: "../media/alert1.png",
        };
    const maybePromise = chrome.action.setIcon({ path });
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch (_) {}
}

async function ensureConsentStatus({
  forceServerRefresh = false,
  promptUser = false,
} = {}) {
  try {
    if (!state.CURRENT_USER_ID) {
      updateExtensionIcon(false);
      return false;
    }
    if (forceServerRefresh) {
      await consent.refreshConsentFromServer(state, URLS_SERVER, true);
    }
    const allowed = await consent.hasConsent(state.CURRENT_USER_ID);
    updateExtensionIcon(allowed);
    if (!allowed && promptUser) {
      await maybeNotifyConsentRequired();
    }
    return allowed;
  } catch (e) {
    return false;
  }
}

async function maybeNotifyConsentRequired() {
  try {
    const now = Date.now();
    if (now - state.lastConsentPromptAt < CONSENT_PROMPT_COOLDOWN_MS) return;
    state.lastConsentPromptAt = now;

    const maybePromise = chrome.notifications.create(CONSENT_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: "media/alert1.png",
      title: "CheckMyNews: Consent Needed",
      message:
        "Open CheckMyNews consent page to continue recording Facebook data.",
      priority: 2,
    });
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch (e) {}
}

async function syncConsentIfNeeded() {
  try {
    const uid = state.CURRENT_USER_ID;
    if (!uid) return;
    await consent.refreshConsentFromServer(state, URLS_SERVER, true);
  } catch (e) {}
}

async function syncExtensionIcon() {
  updateExtensionIcon(await hasUserConsent());
}
