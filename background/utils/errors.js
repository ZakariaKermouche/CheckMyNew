// background/utils/errors.js  (MV3 version)

import { lsGet, lsSet } from "./storage.js";
import { fetchWithRetry } from "./fetch.js";

// Keys used in chrome.storage
const SENT_ERRORS_KEY = "sent_errors_mv3";

// --------------- CONSTANTS ---------------
export const MSG_TYPE = "message_type";

export const ERROR_TYPES = {
  CONTENT_SCRIPT_ERROR: "Content script error",
  BACKGROUND_ERROR: "Background script error",
  TEST_ERROR_CONTENT_SCRIPT: "Testing content script error",
  TEST_ERROR_BACKGROUND_SCRIPT: "Testing background script error",
  INJECTION_ERROR: "Injection script error",
  TEST_ERROR_INJECTION_ERROR: "Testing injection script error",
  BACKGROUND_PROBLEM: "Background script problem",
};

export const ERROR_MESSAGE = "error_message";

// --------------- REPLACERS ---------------
export function errorReplacer(key, value) {
  if (value instanceof Error) {
    const err = {};
    Object.getOwnPropertyNames(value).forEach((k) => {
      err[k] = value[k];
    });
    return err;
  }
  return value;
}

// --------------- MESSAGE BUILDERS ---------------
export function constructErrorMsg(targetFunction, errorObject) {
  const version = chrome.runtime.getManifest()?.version || "unknown";
  return (
    "Function " +
    targetFunction.name +
    ": " +
    JSON.stringify(errorObject, errorReplacer) +
    " - Extension version: " +
    version
  );
}

// Hashes user_id, email, phone using sha512 from third-party/sha512.min.js
export function replaceUserIdEmail(obj, sha512) {
  if (!sha512) return obj;

  if (obj.user_id !== undefined && obj.user_id !== "-1" && obj.user_id !== -1) {
    obj.user_id = sha512(String(obj.user_id));
  }

  if (obj.email !== undefined && obj.email !== "") {
    obj.email = sha512(String(obj.email));
  }

  if (obj.phone !== undefined && obj.phone !== "") {
    obj.phone = sha512(String(obj.phone));
  }

  obj.is_hashed = true;
  return obj;
}

// --------------- ERROR STORAGE ---------------
async function loadSentErrors() {
  return (await lsGet(SENT_ERRORS_KEY, [])) || [];
}

async function saveSentErrors(list) {
  await lsSet(SENT_ERRORS_KEY, list);
}

async function alreadySent(errorInfo) {
  const list = await loadSentErrors();
  return list.some(
    (e) =>
      e.user_id === errorInfo.user_id &&
      e.error_message === errorInfo.error_message &&
      e.message_type === errorInfo.message_type
  );
}

async function cleanErrorMessages(list) {
  const res = [];
  const now = Date.now();
  const FIFTEEN_DAYS = 15 * 24 * 60 * 60 * 1000;

  for (const e of list) {
    if (now - e.time <= FIFTEEN_DAYS) res.push(e);
  }

  return res;
}

// --------------- SEND ERROR TO SERVER ---------------
export async function sendErrorMessage(state, errorInfo, errorURL, sha512) {
  if (!errorURL) return;

  let sentList = await loadSentErrors();
  sentList = await cleanErrorMessages(sentList);

  // Attach user_id from state
  errorInfo.user_id = state.CURRENT_USER_ID || null;

  errorInfo = replaceUserIdEmail(errorInfo, sha512);

  if (await alreadySent(errorInfo)) {
    return true; // avoid duplicates
  }

  // Add to list
  sentList.push({
    user_id: errorInfo.user_id,
    error_message: errorInfo.error_message,
    message_type: errorInfo.message_type,
    time: Date.now(),
  });

  await saveSentErrors(sentList);

  // Send to server using fetch
  try {
    const res = await fetchWithRetry(errorURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorInfo),
    });

    if (!res || res.status === "FAILURE") {
      return true;
    }

  } catch (e) {
  }
}

// --------------- DECORATORS ---------------
export async function captureErrorBackground(
  targetFunction,
  args,
  errorUrl,
  returnError,
  state,
  sha512
) {
  try {
    return await targetFunction(...args);
  } catch (error) {
    const errorInfo = {};
    errorInfo[MSG_TYPE] = ERROR_TYPES.BACKGROUND_ERROR;
    errorInfo[ERROR_MESSAGE] = constructErrorMsg(targetFunction, error);

    await sendErrorMessage(state, errorInfo, errorUrl, sha512);
    return returnError;
  }
}

// For content scripts
export function captureErrorContentScript(targetFunction, args, returnError) {
  try {
    return targetFunction(...args);
  } catch (error) {
    const errorInfo = {};
    errorInfo[MSG_TYPE] = ERROR_TYPES.CONTENT_SCRIPT_ERROR;
    errorInfo[ERROR_MESSAGE] = constructErrorMsg(targetFunction, error);

    try {
      const maybePromise = chrome.runtime.sendMessage(errorInfo);
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch(() => {});
      }
    } catch (_) {}
    return returnError;
  }
}

// Test helpers
export function captureErrorContentScriptTest() {
  try {
    throw "Test content script error";
  } catch (error) {
    const errorInfo = {};
    errorInfo[MSG_TYPE] = ERROR_TYPES.TEST_ERROR_CONTENT_SCRIPT;
    errorInfo[ERROR_MESSAGE] = constructErrorMsg(
      captureErrorContentScriptTest,
      error
    );

    try {
      const maybePromise = chrome.runtime.sendMessage(errorInfo);
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch(() => {});
      }
    } catch (_) {}
  }
}

export async function captureErrorBackgroundTest(state, errorUrl, sha512) {
  try {
    throw "Test background script error";
  } catch (error) {
    const errorInfo = {};
    errorInfo[MSG_TYPE] = ERROR_TYPES.TEST_ERROR_BACKGROUND_SCRIPT;
    errorInfo[ERROR_MESSAGE] = constructErrorMsg(
      captureErrorBackgroundTest,
      error
    );

    await sendErrorMessage(state, errorInfo, errorUrl, sha512);
  }
}
