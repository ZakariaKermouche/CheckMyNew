// content-scripts/interaction-tracker.js

(function () {
  if (!location.hostname.includes("facebook.com")) return;

  const CLICK_THROTTLE_MS = 300;
  const MOVE_THROTTLE_MS = 1000;
  const RETRY_INTERVAL_MS = 2000;
  const MAX_RETRY_AGE_MS = 30000;

  let lastClick = 0;
  let lastMove = 0;
  const pendingClicks = [];

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
    const aria = (
      target?.getAttribute?.("aria-label") ||
      target?.closest?.("[aria-label]")?.getAttribute?.("aria-label") ||
      ""
    ).toLowerCase();
    const probe = `${text} ${aria}`;
    if (probe.includes("comment")) return "CommentButtonClick";
    if (probe.includes("share")) return "Share";
    if (probe.includes("like") || probe.includes("j’aime") || probe.includes("j'aime")) return "Like";
    if (probe.includes("love")) return "Love";
    if (probe.includes("haha")) return "Haha";
    if (probe.includes("wow")) return "Wow";
    if (probe.includes("care")) return "Care";
    if (probe.includes("sad")) return "Sad";
    if (probe.includes("angry")) return "Angry";
    if (probe.includes("react")) return "Reaction";
    if (target?.closest?.("img")) return "ImageClicked";
    return "ImageClicked";
  }

  function resolvePostDataByElement(cmn, target, maxDepth = 10) {
    let el = target instanceof HTMLElement ? target : target?.parentElement;
    for (let i = 0; el && i < maxDepth; i += 1) {
      for (const [mapPostId, mapEl] of cmn?.domElementByPostId || []) {
        if (
          mapEl &&
          (mapEl === el || (typeof mapEl.contains === "function" && mapEl.contains(el)))
        ) {
          return cmn.graphqlPostsMap?.get(mapPostId) || null;
        }
      }
      el = el.parentElement;
    }
    return null;
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
    if (!postData) {
      postData = resolvePostDataByElement(cmn, target);
      if (postData && !postId) {
        postId = postData.post_id || postData.id || null;
      }
    }

    return {
      postId,
      dbId: postData?.dbId || null,
      adId: postData?.ad?.ad_id || null,
      lastAdPosition: getRectSnapshot(el),
      imagePosition: getRectSnapshot(target?.closest?.("img")),
    };
  }

  function sendClickEvent({ dbId, eventType, postId, adId, timestamp }) {
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime
        .sendMessage({
          type: "mouseClick",
          dbId,
          eventType,
          postId,
          adId,
          timestamp,
        })
        .then((resp) => {
          console.log("[CMN] 🖱️ click sent:", {
            dbId,
            postId,
            eventType,
            response: resp || null,
          });
        })
        .catch((err) => {
          console.warn("[CMN] ⚠️ click send failed:", err?.message || String(err));
        });
    } catch (_) {}
  }

  function resolveTrackingId({ dbId, postId, adId }) {
    if (!dbId) return null;
    return String(dbId);
  }

  function flushPendingClicks() {
    if (pendingClicks.length === 0) return;
    const now = nowMs();
    const keep = [];
    for (const ev of pendingClicks) {
      if (now - ev.timestamp > MAX_RETRY_AGE_MS) {
        continue;
      }
      const { dbId, postId, adId } = getPostContextFromTarget(ev.target);
      const trackingId = resolveTrackingId({ dbId, postId, adId });
      if (trackingId) {
        sendClickEvent({
          dbId: trackingId,
          eventType: ev.eventType,
          postId: ev.postId,
          adId: ev.adId,
          timestamp: ev.timestamp,
        });
      } else {
        keep.push(ev);
      }
    }
    pendingClicks.length = 0;
    pendingClicks.push(...keep);
  }

  document.addEventListener(
    "click",
    (event) => {
      const ts = nowMs();
      if (ts - lastClick < CLICK_THROTTLE_MS) return;
      lastClick = ts;

      const { postId, adId, dbId } = getPostContextFromTarget(event.target);
      const eventType = inferClickType(event.target);
      const trackingId = resolveTrackingId({ dbId, postId, adId });
      if (trackingId) {
        sendClickEvent({
          dbId: trackingId,
          eventType,
          postId,
          adId,
          timestamp: ts,
        });
      } else if (postId) {
        pendingClicks.push({
          target: event.target,
          postId,
          adId,
          eventType,
          timestamp: ts,
        });
        console.log("[CMN] ⏳ click queued waiting dbId:", { postId, eventType });
      } else {
        console.warn("[CMN] ⚠️ click skipped: no trackable post/ad context");
      }
    },
    true
  );

  document.addEventListener(
    "mousemove",
    (event) => {
      const ts = nowMs();
      if (ts - lastMove < MOVE_THROTTLE_MS) return;
      lastMove = ts;
      const { dbId, adId, postId, lastAdPosition, imagePosition } =
        getPostContextFromTarget(event.target);
      const trackingId = resolveTrackingId({ dbId, postId, adId });
      if (!trackingId) return;
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
              dbId: trackingId,
              postId,
              adId,
              timeElapsed: getTimeElapsed(),
              frames,
              window: windowSnapshot,
              lastAdPosition,
              imagePosition,
              timestamp: ts,
            })
            .then((resp) => {
              console.log("[CMN] 🖱️ move sent:", {
                dbId: trackingId,
                response: resp || null,
              });
            })
            .catch((err) => {
              console.warn("[CMN] ⚠️ move send failed:", err?.message || String(err));
            });
        }
      } catch (_) {}
    },
    { passive: true }
  );

  setInterval(flushPendingClicks, RETRY_INTERVAL_MS);
})();
