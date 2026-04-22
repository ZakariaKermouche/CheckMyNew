// background/detectors.js
// MV3 rewrite of interfaceVersionDetection.js

import { lsGet, lsSet } from "./utils/storage.js";
import { fetchWithRetry } from "./utils/fetch.js";
import { replaceUserIdEmail } from "./utils/errors.js";
import { INTERFACE_VERSIONS } from "./utils/constants.js";

// Store key names
const KEY_USER_INTERFACE_VERSION = "user_interface_version";
const KEY_NEW_INTERFACE_SENT = "new_interface_sent";

// ------------------------------------------------------
// Initialize storage maps
// ------------------------------------------------------
async function ensureMapsExist() {
  const v = await lsGet(KEY_USER_INTERFACE_VERSION, null);
  if (!v) await lsSet(KEY_USER_INTERFACE_VERSION, {});

  const sent = await lsGet(KEY_NEW_INTERFACE_SENT, null);
  if (!sent) await lsSet(KEY_NEW_INTERFACE_SENT, []);
}

// ------------------------------------------------------
export async function getUserInterfaceVersion(state, userId) {
  await ensureMapsExist();
  const versions = await lsGet(KEY_USER_INTERFACE_VERSION, {});
  return versions[userId] || INTERFACE_VERSIONS.UNKNOWN;
}

// ------------------------------------------------------
export async function setUserInterfaceVersion(
  state,
  userId,
  version,
  URLS_SERVER,
  sha512
) {
  await ensureMapsExist();
  const versions = await lsGet(KEY_USER_INTERFACE_VERSION, {});
  versions[userId] = version;
  await lsSet(KEY_USER_INTERFACE_VERSION, versions);

  if (version === INTERFACE_VERSIONS.NEW) {
    await sendNewVersionDetected(state, userId, URLS_SERVER, sha512);
  }
}

// ------------------------------------------------------
async function addUserToNewInterfaceSent(userId) {
  const sent = await lsGet(KEY_NEW_INTERFACE_SENT, []);
  if (!sent.includes(userId)) {
    sent.push(userId);
    await lsSet(KEY_NEW_INTERFACE_SENT, sent);
  }
}

// ------------------------------------------------------
async function sendNewVersionDetected(state, userId, URLS_SERVER, sha512) {
  if (!userId || userId === -1) return;

  await ensureMapsExist();
  const alreadySent = await lsGet(KEY_NEW_INTERFACE_SENT, []);
  if (alreadySent.includes(userId)) return;

  const data = {
    user_id: userId,
    status: "New Interface",
    timestamp: Date.now(),
  };

  const body = JSON.stringify(replaceUserIdEmail(data, sha512));

  const resp = await fetchWithRetry(URLS_SERVER.newInterfaceDetected, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!resp || resp.status === "FAILURE") {
    return;
  }

  await addUserToNewInterfaceSent(userId);
}
// ------------------------------------------------------
// Handle UI detection message from content script
// ------------------------------------------------------
export async function handleUiDetectionMessage(message, state, URLS_SERVER) {
  const { version } = message;
  const userId = state.CURRENT_USER_ID;

  if (!version || !userId) {
    return;
  }
  const normalized = normalizeVersion(version);

  await setUserInterfaceVersion(state, userId, normalized, URLS_SERVER);
}
function normalizeVersion(version) {
  if (version === "comet") return INTERFACE_VERSIONS.NEW;
  if (version === "classic") return INTERFACE_VERSIONS.OLD;
  return INTERFACE_VERSIONS.UNKNOWN;
}

// ------------------------------------------------------
export function detectInterfaceVersionFromHTML(html) {
  if (!html.includes('id="facebook"')) return INTERFACE_VERSIONS.UNKNOWN;
  if (html.includes("userNavigationLabel")) return INTERFACE_VERSIONS.OLD;
  return INTERFACE_VERSIONS.NEW;
}

// ------------------------------------------------------
export function detectInterfaceVersionFromDoc(doc) {
  const hasFacebook = !!doc.getElementById("facebook");
  if (!hasFacebook) return INTERFACE_VERSIONS.UNKNOWN;
  return doc.getElementById("userNavigationLabel")
    ? INTERFACE_VERSIONS.OLD
    : INTERFACE_VERSIONS.NEW;
}

// ------------------------------------------------------
export async function initDetectors(state) {
  await ensureMapsExist();
  return true;
}
