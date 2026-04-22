// background/utils/storage.js
// A clean MV3 replacement for all storage operations.

// Promise wrapper for chrome.storage.local.get
export async function lsGet(key, defaultValue = null) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (res) => {
      if (res && res[key] !== undefined) resolve(res[key]);
      else resolve(defaultValue);
    });
  });
}

// Promise wrapper for chrome.storage.local.set
export async function lsSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve(true));
  });
}

// Promise wrapper for chrome.storage.local.remove
export async function lsRemove(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, () => resolve(true));
  });
}

// Helper: set multiple keys at once
export async function lsSetMany(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve(true));
  });
}

// Helper: get many keys at once
export async function lsGetMany(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (res) => resolve(res));
  });
}
