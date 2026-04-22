// content-scripts/interaction-tracker.js

(function () {
  if (!location.hostname.includes("facebook.com")) return;

  const CLICK_THROTTLE_MS = 300;
  const MOVE_THROTTLE_MS = 1000;

  let lastClick = 0;
  let lastMove = 0;

  function nowMs() {
    return Date.now();
  }

  function getTimeElapsed() {
    if (typeof performance?.now === "function") {
      return Math.floor(performance.now());
    }
    return 0;
  }

  function getWindowSnapshot() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      url: window.location.href,
    };
  }

  function getRectSnapshot(el) {
    if (!(el instanceof Element)) return {};
    const rect = el.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function inferClickType(target) {
    const text = (target?.textContent || "").trim().toLowerCase();
    if (target?.closest?.("img")) return "ImageClicked";
    if (text.includes("comment")) return "CommentButtonClick";
    if (text.includes("share")) return "Share";
    if (text.includes("like")) return "Like";
    if (text.includes("love")) return "Love";
    if (text.includes("haha")) return "Haha";
    if (text.includes("wow")) return "Wow";
    if (text.includes("care")) return "Care";
    if (text.includes("sad")) return "Sad";
    if (text.includes("angry")) return "Angry";
    return "ImageClicked";
  }

  function getPostContextFromTarget(target) {
    const cmn = window.CMN;
    if (!cmn || !target) return {};

    let el = target instanceof HTMLElement ? target : target?.parentElement;
    let postId = null;
    let postData = null;

    for (let i = 0; el && i < 8; i += 1) {
      if (cmn.extractPostIdFromElement) {
        postId = cmn.extractPostIdFromElement(el);
        if (postId) break;
      }
      el = el.parentElement;
    }

    if (postId && cmn.graphqlPostsMap instanceof Map) {
      postData = cmn.graphqlPostsMap.get(postId) || null;
    }

    return {
      postId,
      dbId: postData?.dbId || null,
      adId: postData?.ad?.ad_id || null,
      lastAdPosition: getRectSnapshot(el),
      imagePosition: getRectSnapshot(target?.closest?.("img")),
    };
  }

  document.addEventListener(
    "click",
    (event) => {
      const ts = nowMs();
      if (ts - lastClick < CLICK_THROTTLE_MS) return;
      lastClick = ts;

      const { postId, adId, dbId } = getPostContextFromTarget(event.target);
      if (!dbId) return;

      try {
        if (chrome?.runtime?.id) {
          chrome.runtime
            .sendMessage({
              type: "mouseClick",
              dbId,
              eventType: inferClickType(event.target),
              postId,
              adId,
              timestamp: ts,
            })
            .catch(() => {});
        }
      } catch (_) {}
    },
    true
  );

  document.addEventListener(
    "mousemove",
    (event) => {
      const ts = nowMs();
      if (ts - lastMove < MOVE_THROTTLE_MS) return;
      lastMove = ts;
      const { dbId, adId, lastAdPosition, imagePosition } =
        getPostContextFromTarget(event.target);
      if (!dbId) return;
      const windowSnapshot = getWindowSnapshot();
      const frames = [
        {
          x: event.clientX,
          y: event.clientY,
          ts,
        },
      ];

      try {
        if (chrome?.runtime?.id) {
          chrome.runtime
            .sendMessage({
              type: "mouseMove",
              dbId,
              timeElapsed: getTimeElapsed(),
              frames,
              window: windowSnapshot,
              lastAdPosition,
              imagePosition,
              timestamp: ts,
            })
            .catch(() => {});
        }
      } catch (_) {}
    },
    { passive: true }
  );
})();
