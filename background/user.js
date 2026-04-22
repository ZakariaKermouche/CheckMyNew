// background/user.js
// Complete MV3 rewrite of the original userIdentification.js (no DOM in SW)

import { lsGet, lsSet } from "./utils/storage.js";
import { offscreenRequest } from "./utils/domparser.js";

// ------------------------------------------------------
// Extract user ID from HTML via OFFSCREEN DOCUMENT
// ------------------------------------------------------
async function extractUserIdFromHTML(html) {
  // Ask offscreen.html to parse HTML and extract user ID + interface version.
  const result = await offscreenRequest("extractUserId", { html });

  // result = { userId: "...", interfaceVersion: "old"|"new"|null }
  return result || { userId: null, interfaceVersion: null };
}

// ------------------------------------------------------
// Load Facebook HTML and request parsing
// ------------------------------------------------------
async function fetchFacebookHome() {
  const resp = await fetch("https://www.facebook.com/me", {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "text/html",
    },
  });

  if (!resp.ok) return null;
  return await resp.text();
}

// ------------------------------------------------------
// MAIN: Get Current User ID
// ------------------------------------------------------
export async function updateCurrentUser(state) {
  try {
    const html = await fetchFacebookHome();
    if (!html) {
      state.CURRENT_USER_ID = null;
      state.LOGGED_IN = false;
      return null;
    }

    const { userId, interfaceVersion } = await extractUserIdFromHTML(html);

    state.FACEBOOK_INTERFACE_VERSION = interfaceVersion;
    state.CURRENT_USER_ID = userId;
    state.LOGGED_IN = !!userId;

    if (userId) {
      await lsSet("CURRENT_USER_ID", userId);
    }

    return userId;
  } catch (e) {
    state.CURRENT_USER_ID = null;
    state.LOGGED_IN = false;
    return null;
  }
}

// ------------------------------------------------------
// Helper to retrieve stored user ID on startup
// ------------------------------------------------------
export async function initUserSystem(state) {

  const storedId = await lsGet("CURRENT_USER_ID", null);
  if (storedId) {
    state.CURRENT_USER_ID = storedId;
    state.LOGGED_IN = true;
  } else {
    await updateCurrentUser(state);
  }
}
