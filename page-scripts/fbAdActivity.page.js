// page-scripts/fbAdActivity.page.js

// Ad activity is disabled; keep this file as a no-op to avoid message sends.
if (true) {
  // Intentionally disabled.
} else {

(function () {
  if (window.__CMN_AD_ACTIVITY_PAGE__) return;
  window.__CMN_AD_ACTIVITY_PAGE__ = true;

  // Facebook response keys
  const PAYLOAD = "payload";
  const HISTORY_CLICKED = "click_history";
  const HISTORY_ROWS = "history_rows";
  const HAS_MORE = "has_more_items";
  const LAST_ITEM = "last_item_served_hash";

  const ADACTIVITYURLS = [
    "/business_integrity/purchase_history/purchase_history_row_data/",
    "/ads/activity/business_integrity/purchase_history/purchase_history_row_data/",
    // Removed (404): https://www.facebook.com/business_integrity/purchase_history/purchase_history_row_data/
    "https://www.facebook.com/ads/activity/business_integrity/purchase_history/purchase_history_row_data/",
  ];
  const ADCONTENTURL =
    "/click_activity/preview_contents/?ad_id={0}&image_height=78&image_width=150";

  function safeRequire(name) {
    try {
      if (typeof window.require === "function") {
        return window.require(name);
      }
    } catch (_) {}
    return null;
  }

  function getAsyncParams() {
    const getAsyncParamsFn = safeRequire("getAsyncParams");
    if (typeof getAsyncParamsFn === "function") {
      return getAsyncParamsFn("POST") || {};
    }
    return {};
  }

  function encodeBody(extraPrefix = "") {
    const params = getAsyncParams();
    const body = new URLSearchParams(params).toString();
    if (!extraPrefix) return body;
    if (extraPrefix.endsWith("&")) return extraPrefix + body;
    return `${extraPrefix}&${body}`;
  }

  async function postForm(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      credentials: "include",
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }

  function parseFBJSON(text) {
    if (!text) return null;
    let cleaned = text.trim();
    if (cleaned.startsWith("for (;;);")) {
      cleaned = cleaned.slice("for (;;);".length);
    }
    if (!(cleaned.startsWith("{") || cleaned.startsWith("["))) {
      return null;
    }
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      return null;
    }
  }

  async function fetchAdActivityData(adId) {
    if (!adId) return;
    const url = ADCONTENTURL.replace("{0}", encodeURIComponent(adId));
    try {
      const resp = await postForm(url, encodeBody());
      if (!resp.ok) {
        return;
      }
      const respData = parseFBJSON(resp.text);
      if (!respData || !respData[PAYLOAD]) return;
      window.postMessage(
        {
          source: "CMN_AD_ACTIVITY",
          type: "adActivityData",
          adId,
          data: respData[PAYLOAD],
        },
        "*"
      );
    } catch (e) {
    }
  }

  async function fetchAdActivityList(lastItem) {
    try {
      const lastItemParam =
        lastItem && lastItem !== "-1"
          ? `see_more_type=adClicks&last_item_served_hash=${encodeURIComponent(
              lastItem
            )}&`
          : "";

      let resp = null;
      let respData = null;
      let usedUrl = null;
      for (const url of ADACTIVITYURLS) {
        resp = await postForm(url, encodeBody(lastItemParam));
        if (!resp.ok) {
          continue;
        }
        respData = parseFBJSON(resp.text);
        if (respData && respData[PAYLOAD]) {
          usedUrl = url;
          break;
        }
      }

      if (!respData || !respData[PAYLOAD]) {
        const status = resp?.status;
        const snippet = (resp?.text || "").slice(0, 120);
        return;
      }

      const adClickedData =
        respData[PAYLOAD]?.[HISTORY_CLICKED]?.[HISTORY_ROWS] || {};
      const hasMoreItems =
        respData[PAYLOAD]?.[HISTORY_CLICKED]?.[HAS_MORE] || false;
      const lastItemHash =
        respData[PAYLOAD]?.[HISTORY_CLICKED]?.[LAST_ITEM] || null;

      window.postMessage(
        {
          source: "CMN_AD_ACTIVITY",
          type: "adActivityList",
          adClickedData,
          hasMoreItems,
          lastItem: lastItemHash,
        },
        "*"
      );

      // Fetch per-ad details
      const adIds = Object.keys(adClickedData || {});
      for (const adId of adIds) {
        fetchAdActivityData(adId);
      }
    } catch (e) {
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "CMN_CONTENT") return;

    if (data.type === "CMN_AD_ACTIVITY_FETCH") {
      fetchAdActivityList(data.lastItem || "-1");
    } else if (data.type === "CMN_AD_ACTIVITY_FETCH_DETAIL") {
      fetchAdActivityData(data.adId);
    }
  });
})();
}
