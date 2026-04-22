// background/utils/general.js (MV3 version)

// -----------------------------------------------------
// This file replaces the old MV2 general.js
// All globals are removed and everything is modular.
// -----------------------------------------------------

// ---------- IMPORTS ----------
import { lsGet, lsSet } from "./storage.js";

// ---------- CONSTANTS ----------
export const REQUEST_TYPE = "POST"; // preserved
export const POPUP_HTML = "ui/popup.html?welcome=true";

// You must import FACEBOOK_URL from constants.js once we migrate that file
// Example:
// import { FACEBOOK_URL } from "./utils/constants.js";

// ---------- USER DETECTION (MV3 Safe) ----------
export function isCurrentUser(state) {
  const id = state.CURRENT_USER_ID;
  return !!id && id !== -1 && id !== "-1";
}

// ---------- EMAIL VALIDATION (MV3 Safe) ----------
export function isEmail(value) {
  // No DOM in service worker — use regex instead
  return /\S+@\S+\.\S+/.test(value);
}

// ---------- GENERIC REQUEST CALLBACKS ----------
export function genericRequestSuccess() {
  return; // kept identical to MV2 behavior
}

export function genericRequestError() {
  return;
}

// ---------- SET HEADER KEY ----------
export function setHeaderKey(details, headerName, newVal) {
  let found = false;

  for (let h of details.requestHeaders) {
    if (h.name.toLowerCase() === headerName.toLowerCase()) {
      h.value = newVal;
      found = true;
      break;
    }
  }

  if (!found) {
    details.requestHeaders.push({ name: headerName, value: newVal });
  }

  return { requestHeaders: details.requestHeaders };
}

// ---------- REQUEST ORIGIN DETECTION ----------
export function isUserRequest(details, FACEBOOK_URL) {
  // MV3 has different request details model.
  // Instead of details.initiator, use details.initiator or details.documentUrl.

  if (details.initiator && details.initiator.includes(FACEBOOK_URL)) {
    return true;
  }

  if (details.documentUrl && details.documentUrl.includes(FACEBOOK_URL)) {
    return true;
  }

  const tabId = details.tabId;
  if (tabId !== undefined && tabId !== -1) {
    return true;
  }

  return false;
}

// ---------- FIND INDEX IN LIST ----------
export function getIndexFromList(txt, lst) {
  for (let i = 0; i < lst.length; i++) {
    const idx = txt.indexOf(lst[i]);
    if (idx >= 0) return idx;
  }
  return -1;
}
