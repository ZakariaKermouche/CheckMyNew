// background/news.js
// Final unified MV3 news tracking system: visits + reading time + classification

import { lsGet, lsSet } from "./utils/storage.js";
import { NEWS_DOMAINS, NEWS_DOMAIN_SHORTCUTS } from "./utils/newsConstants.js";

// -------------------------------------------------------
// Storage keys
// -------------------------------------------------------
const NEWS_ACTIVITY_KEY = "news_activity"; // domain → total ms
const NEWS_VISITS_KEY = "news_visits"; // list of visit events
const TAB_STATE_KEY = "news_tab_state"; // optional persistence

// In-memory tab state
const tabState = {}; // tabId → { domain, url, isNews, lastFocused }
let initialized = false;

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------
function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizeDomain(domain) {
  if (!domain) return null;

  domain = domain.toLowerCase().trim();
  if (NEWS_DOMAIN_SHORTCUTS[domain]) return NEWS_DOMAIN_SHORTCUTS[domain];

  if (domain.startsWith("www.")) return domain.slice(4);

  return domain;
}

function detectNewsOrg(domain) {
  const norm = normalizeDomain(domain);
  return NEWS_DOMAINS[norm] || null;
}

function classifyNews(org) {
  if (!org) return "unknown";
  return NEWS_CATEGORIES[org] || "unknown";
}

// -------------------------------------------------------
// VISIT LOGGING (URL-level + domain-level)
// -------------------------------------------------------
async function recordNewsVisit(domain, url) {
  const org = detectNewsOrg(domain);
  if (!org) return;

  const normalized = normalizeDomain(domain);

  let visits = (await lsGet(NEWS_VISITS_KEY)) || [];
  visits.push({
    domain: normalized,
    url,
    organization: org,
    category: classifyNews(org),
    timestamp: Date.now(),
  });

  await lsSet(NEWS_VISITS_KEY, visits);

}

// -------------------------------------------------------
// TIME TRACKING (your original logic, improved)
// -------------------------------------------------------
async function addNewsTime(domain, deltaMs) {
  if (!domain || deltaMs <= 0) return;

  const map = (await lsGet(NEWS_ACTIVITY_KEY, {})) || {};
  map[domain] = (map[domain] || 0) + deltaMs;

  await lsSet(NEWS_ACTIVITY_KEY, map);
}

// -------------------------------------------------------
// Tab event: updated
// -------------------------------------------------------
async function handleTabUpdated(tabId, changeInfo, tab) {
  if (!tab.url) return;

  const now = Date.now();
  const domain = extractDomain(tab.url);
  const normalized = normalizeDomain(domain);
  const isNews = detectNewsOrg(normalized) !== null;

  // If previously focused and was news, accumulate time
  const prev = tabState[tabId];
  if (prev?.isNews && prev.lastFocused) {
    const delta = now - prev.lastFocused;
    await addNewsTime(prev.domain, delta);
  }

  // Log visit only when URL changes significantly
  if (!prev || prev.url !== tab.url) {
    if (isNews) await recordNewsVisit(normalized, tab.url);
  }

  tabState[tabId] = {
    domain: normalized,
    url: tab.url,
    isNews,
    lastFocused: now,
  };
}

// -------------------------------------------------------
// Tab event: removed
// -------------------------------------------------------
async function handleTabRemoved(tabId) {
  const now = Date.now();
  const prev = tabState[tabId];

  if (prev?.isNews && prev.lastFocused) {
    const delta = now - prev.lastFocused;
    await addNewsTime(prev.domain, delta);
  }

  delete tabState[tabId];
}

// -------------------------------------------------------
// Tab activated (switch focus between tabs)
// -------------------------------------------------------
async function handleActivated(activeInfo) {
  const now = Date.now();
  const activeTabId = activeInfo.tabId;

  // Pause all other news tabs
  for (const [id, info] of Object.entries(tabState)) {
    const numericId = Number(id);
    if (numericId === activeTabId) continue;

    if (info.isNews && info.lastFocused) {
      const delta = now - info.lastFocused;
      await addNewsTime(info.domain, delta);
      tabState[numericId].lastFocused = null;
    }
  }

  // Start focus timer for active tab
  chrome.tabs.get(activeTabId, async (tab) => {
    if (!tab || !tab.url) return;

    const domain = extractDomain(tab.url);
    const normalized = normalizeDomain(domain);
    const isNews = detectNewsOrg(normalized) !== null;

    // Record visit if new URL
    const prev = tabState[activeTabId];
    if (!prev || prev.url !== tab.url) {
      if (isNews) await recordNewsVisit(normalized, tab.url);
    }

    tabState[activeTabId] = {
      domain: normalized,
      url: tab.url,
      isNews,
      lastFocused: now,
    };
  });
}

// -------------------------------------------------------
// PUBLIC API for popup/dashboard
// -------------------------------------------------------
export async function getNewsActivity() {
  return (await lsGet(NEWS_ACTIVITY_KEY)) || {};
}

export async function getNewsVisits() {
  return (await lsGet(NEWS_VISITS_KEY)) || [];
}

// -------------------------------------------------------
// Initialization for service worker
// -------------------------------------------------------
export async function initNewsSystem() {
  if (initialized) return;
  initialized = true;

  chrome.tabs.onUpdated.addListener(handleTabUpdated);
  chrome.tabs.onRemoved.addListener(handleTabRemoved);
  chrome.tabs.onActivated.addListener(handleActivated);
}
