// background/utils/domparser.js

export async function offscreenRequest(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        _offscreen: true,
        type,
        payload,
      },
      (response) => {
        resolve(response);
      }
    );
  });
}
