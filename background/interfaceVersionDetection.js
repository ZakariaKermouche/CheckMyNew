// background/interfaceVersionDetection.js
// Modern MV3 interface version detection for Facebook (Comet vs Classic)

import { lsGet, lsSet } from "./utils/storage.js";

const UI_VERSION_KEY = "FACEBOOK_UI_VERSION";
const MOBILE_FLAG_KEY = "FACEBOOK_MOBILE";

// Enumerations
export const UI_CLASSIC = "classic";
export const UI_COMET = "comet";
export const UI_UNKNOWN = "unknown";

/**
 * Initialize system: load previous known UI version
 */
export async function initInterfaceVersionDetection(state) {
  state.FACEBOOK_UI_VERSION = (await lsGet(UI_VERSION_KEY)) || UI_UNKNOWN;

  state.FACEBOOK_MOBILE = (await lsGet(MOBILE_FLAG_KEY)) || false;

}

/**
 * Update stored UI version
 */
export async function setInterfaceVersion(version, mobile = false) {
  await lsSet(UI_VERSION_KEY, version);
  await lsSet(MOBILE_FLAG_KEY, !!mobile);


  // Notify popup/components
  chrome.runtime.sendMessage({
    type: "uiVersionUpdated",
    version,
    mobile,
  });
}

/**
 * Primary entry: content-script sends detection result
 *
 * Example message:
 * {
 *    type: "ui-detection",
 *    version: "comet",
 *    mobile: false
 * }
 */
export async function handleUiDetectionMessage(msg) {
  if (!msg.version) return;

  await setInterfaceVersion(msg.version, msg.mobile);
}

/**
 * Helpers for other modules
 */
export function getUiVersion(state) {
  return state.FACEBOOK_UI_VERSION || UI_UNKNOWN;
}

export function isComet(state) {
  return getUiVersion(state) === UI_COMET;
}

export function isClassic(state) {
  return getUiVersion(state) === UI_CLASSIC;
}

export function isMobile(state) {
  return !!state.FACEBOOK_MOBILE;
}
