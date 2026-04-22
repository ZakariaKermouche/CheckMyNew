// background/ads.js
// Clean MV3 ads module — handles front ads, side ads, clicked ads
// Uses offscreen for image conversion and communicates with service worker

import { offscreenRequest } from "./utils/domparser.js";
import { lsGet, lsSet } from "./utils/storage.js";
import { replaceUserIdEmail } from "./utils/errors.js";

// Utility: safe JSON POST
async function postJSON(url, bodyObj) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const REGISTER_AD_REQUIRED_BASE = ["type", "timestamp", "raw_ad", "user_id"];
const REGISTER_AD_REQUIRED_BY_TYPE = {
  frontAd: [
    "html_ad_id",
    "visible",
    "visible_fraction",
    "visibleDuration",
    "offsetX",
    "offsetY",
    "landing_pages",
    "images",
  ],
  newsPost: [
    "html_ad_id",
    "visible",
    "visible_fraction",
    "visibleDuration",
    "offsetX",
    "offsetY",
    "landing_pages",
    "images",
    "landing_domain",
  ],
  publicPost: [
    "html_ad_id",
    "visible",
    "visible_fraction",
    "visibleDuration",
    "offsetX",
    "offsetY",
    "landing_pages",
    "images",
  ],
  sideAd: ["fb_id"],
};

function missingFields(payload, fields) {
  return fields.filter((k) => {
    if (!(k in payload)) return true;
    const v = payload[k];
    if (v === undefined || v === null) return true;
    if (typeof v === "string" && v.trim() === "") return true;
    return false;
  });
}

function validateAndLogRegisterAdPayload(payload) {
  const type = payload?.type || payload?.adType || "unknown";
  const required = [
    ...REGISTER_AD_REQUIRED_BASE,
    ...(REGISTER_AD_REQUIRED_BY_TYPE[type] || []),
  ];
  const missing = missingFields(payload || {}, required);
  const summary = {
    type,
    html_ad_id: payload?.html_ad_id || null,
    adanalyst_ad_id: payload?.adanalyst_ad_id || null,
    fb_id: payload?.fb_id || null,
    has_media_content:
      payload?.media_content && Object.keys(payload.media_content).length > 0,
    missing_count: missing.length,
    missing,
  };
  const fullPayload = {
    ...(payload || {}),
    raw_ad_preview:
      typeof payload?.raw_ad === "string"
        ? payload.raw_ad.slice(0, 400)
        : payload?.raw_ad || null,
    raw_ad_length:
      typeof payload?.raw_ad === "string" ? payload.raw_ad.length : 0,
  };
  delete fullPayload.raw_ad;
  if (missing.length > 0) {
  } else {
  }
}

// -----------------------------------------------------------
// IMAGE → BASE64 via OFFSCREEN
// -----------------------------------------------------------
async function convertImagesToBase64(urls) {
  if (!urls || urls.length === 0) return {};
  try {
    const response = await offscreenRequest("imagesToDataURLs", { urls });
    const map = response && typeof response === "object" ? response.map : null;
    return map || {};
  } catch (e) {
    return {};
  }
}

function attachmentMediaUrls(attachments) {
  const urls = new Set();
  const list = Array.isArray(attachments) ? attachments : [];
  for (const att of list) {
    if (att?.image?.flexible) urls.add(att.image.flexible);
    if (att?.image?.large) urls.add(att.image.large);
  }
  return [...urls].filter(Boolean);
}

// -----------------------------------------------------------
// MAIN ENTRY: handleFrontAd()
// Called from service-worker on message.type === "frontAd"
// -----------------------------------------------------------
import "../third-party/sha512.min.js";

const hashFn =
  typeof globalThis?.sha512 === "function"
    ? globalThis.sha512
    : globalThis?.sha512?.sha512?.bind(globalThis.sha512) ||
      globalThis?.sha512?.sha512_384?.bind(globalThis.sha512);

const REGISTER_AD_ALLOWED_FIELDS = new Set([
  "raw_ad",
  "html_ad_id",
  "timestamp",
  "offsetX",
  "offsetY",
  "type",
  "landing_pages",
  "images",
  "visible",
  "visible_fraction",
  "visibleDuration",
  "fb_id",
  "objId",
  "advertiser_facebook_id",
  "advertiser_facebook_page",
  "advertiser_facebook_profile_pic",
  "video",
  "video_id",
  "adanalyst_ad_id",
  "landing_domain",
  "explanationUrl",
  "clientToken",
  "graphQLAsyncParams",
  "serialized_frtp_identifiers",
  "story_debug_info",
  "newInterface",
  "adType",
]);

export async function handleFrontAd(state, URLS_SERVER, message, sendResponse) {
  try {
    const CURRENT_USER_ID = state.CURRENT_USER_ID;
    const images = [
      ...(message.fullImageURLs || []),
      ...(message.imageURLs || []),
      ...(message.advertiserProfilePic ? [message.advertiserProfilePic] : []),
    ];

    const mediaContent = await convertImagesToBase64(images);

    const payload = {
      user_id: CURRENT_USER_ID,
      fb_id: message.fb_id,
      objId: message.objId || null,
      pageName: message.pageName || "",
      text: message.text || "",
      links: message.links || [],
      clientToken: message.clientToken || null,
      graphQLAsyncParams: message.graphQLAsyncParams || null,
      serialized_frtp_identifiers: message.serialized_frtp_identifiers || null,
      story_debug_info: message.story_debug_info || null,
      newInterface: message.newInterface === true,
      adType: message.adType || "feed",
      MEDIA_CONTENT: mediaContent,
      timestamp: Date.now(),
    };

    const requestForServer = await replaceUserIdEmail(payload, hashFn);

    // 3) Send to server
    const resp = await postJSON(URLS_SERVER.registerAd, requestForServer);

    // 4) Reply to content script
    sendResponse?.({
      saved: resp.status !== "FAILURE",
      dbId: resp.ad_id || null,
    });
  } catch (e) {
    sendResponse?.({ saved: false, error: e.toString() });
  }
}

// -----------------------------------------------------------
// handleSideAd (rarely used now, but keeping logic identical)
// -----------------------------------------------------------
export async function handleSideAd(state, URLS_SERVER, message, sendResponse) {
  try {
    const CURRENT_USER_ID = state.CURRENT_USER_ID;
    const images = [
      ...(message.fullImageURLs || []),
      ...(message.imageURLs || []),
      ...(message.advertiserProfilePic ? [message.advertiserProfilePic] : []),
    ];

    const mediaContent = await convertImagesToBase64(images);

    const payload = {
      user_id: CURRENT_USER_ID,
      fb_id: message.fb_id,
      objId: message.objId || null,
      pageName: message.pageName || "",
      text: message.text || "",
      links: message.links || [],
      clientToken: message.clientToken || null,
      graphQLAsyncParams: message.graphQLAsyncParams || null,
      serialized_frtp_identifiers: message.serialized_frtp_identifiers || null,
      story_debug_info: message.story_debug_info || null,
      MEDIA_CONTENT: mediaContent,
      timestamp: Date.now(),
      adType: "sidebar",
    };

    const requestForServer = await replaceUserIdEmail(payload, hashFn);
    const resp = await postJSON(URLS_SERVER.registerAd, requestForServer);

    sendResponse?.({
      saved: resp.status !== "FAILURE",
      dbId: resp.ad_id || null,
    });
  } catch (e) {
    sendResponse?.({ saved: false, error: e.toString() });
  }
}

// -----------------------------------------------------------
// handleClickedAds()
// When content script sends a batch of clicked ad events
// -----------------------------------------------------------
export async function handleClickedAds(
  state,
  URLS_SERVER,
  message,
  sendResponse
) {
  try {
    const CURRENT_USER_ID = state.CURRENT_USER_ID;
    const clickedData = message.adClickedData || {};

    const keys = Object.keys(clickedData);
    if (keys.length === 0) {
      sendResponse?.({ ok: true, count: 0 });
      return;
    }

    for (const k of keys) {
      const req = clickedData[k];

      // Collect all relevant image URLs
      const imgList = [
        ...(req.contents?.fullImageURLs || []),
        ...(req.contents?.imageURLs || []),
      ];

      if (req.contents?.facebookPageProfilePicURL) {
        imgList.push(req.contents.facebookPageProfilePicURL);
      }

      // Convert via offscreen
      const mediaContent = await convertImagesToBase64(imgList);

      const payload = {
        ...req,
        MEDIA_CONTENT: mediaContent,
        user_id: CURRENT_USER_ID,
        timestamp: Date.now(),
      };

      const requestForServer = await replaceUserIdEmail(payload, hashFn);

      try {
        await postJSON(URLS_SERVER.registerClickedAd, requestForServer);
      } catch (e) {
      }
    }

    sendResponse?.({ ok: true, count: keys.length });
  } catch (e) {
    sendResponse?.({ ok: false, error: e.toString() });
  }
}

// -----------------------------------------------------------
// handleRegisterAdBatch()
// Receives MV2-style ad/news post payloads from content scripts
// -----------------------------------------------------------
export async function handleRegisterAdBatch(
  state,
  URLS_SERVER,
  message,
  sendResponse
) {
  try {
    const payloads = Array.isArray(message.payloads) ? message.payloads : [];
    if (payloads.length === 0) {
      sendResponse?.({ ok: true, count: 0 });
      return;
    }

    let success = 0;
    const mappings = [];
    for (const payload of payloads) {
      // media_content comes only from attachment-derived urls.
      const images = Array.isArray(payload.attachment_media_urls)
        ? payload.attachment_media_urls.filter(Boolean)
        : attachmentMediaUrls(payload.attachments);

      const mediaContent = await convertImagesToBase64(images);

      const requestPayload = buildRegisterAdRequestPayload(
        payload,
        state.CURRENT_USER_ID || payload.user_id || null,
        mediaContent
      );

      delete requestPayload.MEDIA_CONTENT;

      const requestForServer = await replaceUserIdEmail(
        requestPayload,
        hashFn
      );
      validateAndLogRegisterAdPayload(requestPayload);
      try {
        const out = await postJSON(URLS_SERVER.registerAd, requestForServer);
        success++;
        const dbId = out?.ad_id || null;
        const adanalystAdId =
          payload?.adanalyst_ad_id || payload?.html_ad_id || null;
        if (dbId && adanalystAdId) {
          mappings.push({
            adanalyst_ad_id: String(adanalystAdId),
            dbId: String(dbId),
          });
        }
      } catch (e) {
      }
    }

    sendResponse?.({ ok: true, count: success, mappings });
  } catch (e) {
    sendResponse?.({ ok: false, error: e.toString() });
  }
}

function buildRegisterAdRequestPayload(payload, userId, mediaContent) {
  const requestPayload = {
    user_id: userId || null,
    media_content: mediaContent || {},
  };
  for (const [k, v] of Object.entries(payload || {})) {
    if (!REGISTER_AD_ALLOWED_FIELDS.has(k)) continue;
    if (v === undefined || v === null) continue;
    requestPayload[k] = v;
  }
  return requestPayload;
}
// Key where ads are stored
const ADS_STORAGE_KEY = "ads_list";

/**
 * Get summary of collected ads for popup UI.
 * Returns:
 * {
 *   count: number,
 *   lastAds: [ ... up to last 5 ads ... ]
 * }
 */
export async function getAdsSummary() {
  let ads = await lsGet(ADS_STORAGE_KEY);
  if (!ads) ads = [];

  // Sort newest → oldest
  ads = ads.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // Take last 5 ads for preview
  const lastAds = ads.slice(0, 5).map((ad) => ({
    fb_id: ad.fb_id,
    adId: ad.adId || ad.dbId || null,
    type: ad.type,
    timestamp: ad.timestamp,
  }));

  return {
    count: ads.length,
    lastAds,
  };
}

async function storeAdLocally(adObj) {
  let ads = await lsGet(ADS_STORAGE_KEY);
  if (!ads) ads = [];

  // Add timestamp if not present
  if (!adObj.timestamp) {
    adObj.timestamp = Date.now();
  }

  ads.unshift(adObj); // newest first

  // Optional: limit local storage to last 500 ads
  if (ads.length > 500) ads = ads.slice(0, 500);

  await lsSet(ADS_STORAGE_KEY, ads);
}
