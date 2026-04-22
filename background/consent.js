// background/consent.js
// Modern MV3 consent management for CheckMyNews

import { lsGet, lsSet } from "./utils/storage.js";
import { replaceUserIdEmail } from "./utils/errors.js";
import "../third-party/sha512.min.js";

/**
 * Storage keys
 */
const CONSENTS_KEY = (uid) => `${uid}_consents`;
const CONSENT_LAST_CHECK_KEY = (uid) => `${uid}_consent_last_check`;
const CONSENT_PAGE_OPENED_KEY = "consent_page_opened";

const CONSENT_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes (MV2 parity)

/**
 * Initialize consent state (called once)
 */
export async function initConsentSystem(state, URLS_SERVER) {
  const uid = state.CURRENT_USER_ID;
  if (!uid) return;

  const consents = await lsGet(CONSENTS_KEY(uid));
  if (!consents) await lsSet(CONSENTS_KEY(uid), "{}");

  const lastCheck = await lsGet(CONSENT_LAST_CHECK_KEY(uid));
  if (!lastCheck) await lsSet(CONSENT_LAST_CHECK_KEY(uid), 0);

}

/**
 * Check if user has consent
 */
export async function hasConsent(userId, mode = 0) {
  if (!userId) return false;

  const stored = await lsGet(CONSENTS_KEY(userId));
  if (!stored) return false;

  try {
    const obj = JSON.parse(stored);
    if (mode === 0) return Object.values(obj).some((x) => x === true);
    return obj[mode] === true;
  } catch (e) {
    return false;
  }
}

/**
 * Server → Extension: refresh consent status
 */
export async function refreshConsentFromServer(
  state,
  URLS_SERVER,
  force = false
) {
  const uid = state.CURRENT_USER_ID;
  if (!uid) return false;

  const now = Date.now();
  const lastCheck = (await lsGet(CONSENT_LAST_CHECK_KEY(uid))) || 0;

  if (!force && now - lastCheck < CONSENT_CHECK_INTERVAL) return;


  try {
    const payload = hashPayload({
      user_id: uid,
      timestamp: now,
    });
    const data = await postForm(URLS_SERVER.getConsent, {
      user_id: payload.user_id,
      is_hashed: true,
    });
    if (!data || typeof data.consents === "undefined") {
      await lsSet(CONSENTS_KEY(uid), "{}");
      await lsSet(CONSENT_LAST_CHECK_KEY(uid), now);
      return false;
    }

    await lsSet(CONSENTS_KEY(uid), JSON.stringify(data.consents || {}));
    await lsSet(CONSENT_LAST_CHECK_KEY(uid), now);

    notifyConsentChange(data.consents || {});
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * MV3 WRAPPER REQUIRED BY SERVICE WORKER
 * service-worker.js calls this every heartbeat
 */
export async function refreshConsent(state, URLS_SERVER) {
  return await refreshConsentFromServer(state, URLS_SERVER, false);
}

/**
 * MV3 REQUIRED FUNCTION — Popup asks “Do I have consent?”
 */

export async function getConsentStatus(state) {
  const uid = state.CURRENT_USER_ID;

  // NOT logged in
  if (!uid || uid === "0" || uid === 0 || typeof uid !== "string") {
    return {
      ok: true,
      consent: false,
      currentUser: null,
    };
  }

  // Logged in → check consent
  const stored = await lsGet(`${uid}_consents`);
  let parsed = {};

  try {
    parsed = stored ? JSON.parse(stored) : {};
  } catch {
    parsed = {};
  }

  const hasConsent = Object.values(parsed).some((v) => v === true);

  return {
    ok: true,
    consent: hasConsent,
    currentUser: uid,
  };
}

/**
 * Register a new consent event
 */
export async function registerConsent(state, URLS_SERVER, consentPayload) {
  const uid = state.CURRENT_USER_ID;
  if (!uid) return { ok: false, error: "no_user_id" };

  try {
    const manifest = chrome.runtime.getManifest();
    const payload = hashPayload({
      user_id: uid,
      extension_version: manifest?.version || "unknown",
      timestamp: Date.now(),
    });

    const out = await postForm(URLS_SERVER.registerConsent, {
      user_id: payload.user_id,
      extension_version: payload.extension_version,
      is_hashed: true,
    });
    const status = String(out?.status || "").toLowerCase();
    if (status === "failure" || typeof out?.consents === "undefined") {
      await lsSet(CONSENTS_KEY(uid), "{}");
      return {
        ok: false,
        error: out?.reason || "register_consent_failed",
        currentUser: uid,
      };
    }

    if (out.consents) {
      await lsSet(CONSENTS_KEY(uid), JSON.stringify(out.consents));
      notifyConsentChange(out.consents);
    }

    return { ok: true, consents: out.consents, currentUser: uid };
  } catch (e) {
    return { ok: false };
  }
}

/**
 * Open consent page
 */
export async function openConsentPage() {
  await chrome.storage.local.set({ [CONSENT_PAGE_OPENED_KEY]: true });
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/new_consent.html") });
}

/**
 * Notify UI
 */
async function notifyConsentChange(consents) {
  try {
    const maybePromise = chrome.runtime.sendMessage({
      type: "consentUpdated",
      consents,
    });
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch (_) {}
}

/**
 * Heartbeat periodic check
 */
export async function periodicConsentCheck(state, URLS_SERVER) {
  await refreshConsentFromServer(state, URLS_SERVER, false);
}

const hashFn =
  typeof globalThis?.sha512 === "function"
    ? globalThis.sha512
    : globalThis?.sha512?.sha512?.bind(globalThis.sha512) ||
      globalThis?.sha512?.sha512_384?.bind(globalThis.sha512);

function hashPayload(payload) {
  return replaceUserIdEmail(payload, hashFn);
}

async function postForm(url, payload) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null) continue;
    body.set(key, String(value));
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
