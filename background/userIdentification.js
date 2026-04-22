// background/userIdentification.js
// MV3-safe FB user identification system

import { lsGet, lsSet } from "./utils/storage.js";

const CURRENT_USER_ID_KEY = "CURRENT_USER_ID";

export function getCurrentUser(state) {
  return state.CURRENT_USER_ID || null;
}

export async function initUserIdentification(state) {
  const stored = await lsGet(CURRENT_USER_ID_KEY);

  if (stored) {
    state.CURRENT_USER_ID = stored;
    state.LOGGED_IN = true;

  } else {
    state.CURRENT_USER_ID = null;
    state.LOGGED_IN = false; // ✅ explicit is better

  }
}

/**
 * Called when fbUserDetector.js sends userIdDetected
 */
export async function updateDetectedUserId(state, userId) {
  if (!userId) return false;

  if (state.CURRENT_USER_ID === userId) return true;


  state.CURRENT_USER_ID = userId;
  state.LOGGED_IN = true;

  await lsSet(CURRENT_USER_ID_KEY, userId);

  try {
    const maybePromise = chrome.runtime.sendMessage({
      type: "userIdUpdated",
      userId,
    });
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch (_) {}

  return true;
}
