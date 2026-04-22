// content-scripts/fbAdActivity.js

// Ad activity is disabled; keep this file as a no-op to avoid message sends.
if (true) {
  // Intentionally disabled.
} else {

class FBAdActivityTracker {
  constructor() {
    this.timer = null;
    this.lastItem = "-1";
    this.lastItemRequested = null;
    this.hasMore = null;
    this.listCache = new Map(); // adId -> list entry
    this.pendingDetails = new Set(); // adIds waiting for detail
    this.boundOnMessage = this.onPageMessage.bind(this);
  }

  start(intervalMs = 10 * 60 * 1000) {
    if (this.timer) return;
    window.addEventListener("message", this.boundOnMessage);
    this.requestList();
    this.timer = setInterval(() => this.requestList(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener("message", this.boundOnMessage);
  }

  requestList() {
    this.requestListWithLastItem(this.lastItem || "-1");
  }

  requestListWithLastItem(lastItem) {
    if (this.lastItemRequested === lastItem) return;
    this.lastItemRequested = lastItem;
    window.postMessage(
      {
        source: "CMN_CONTENT",
        type: "CMN_AD_ACTIVITY_FETCH",
        lastItem: lastItem || "-1",
      },
      "*"
    );
  }

  onPageMessage(event) {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "CMN_AD_ACTIVITY") return;

    if (data.type === "adActivityList") {
      const rows = data.adClickedData || {};
      this.lastItem = data.lastItem || this.lastItem;
      this.hasMore = !!data.hasMoreItems;
      for (const [adId, row] of Object.entries(rows)) {
        this.listCache.set(adId, row);
        if (!row || !row.contents) {
          this.pendingDetails.add(adId);
        }
      }

      // Old behavior: keep fetching next page until no more items.
      if (this.hasMore && this.lastItem) {
        this.requestListWithLastItem(this.lastItem);
      } else {
        this.maybeFlushBatch();
      }
      return;
    }

    if (data.type === "adActivityData") {
      const adId = data.adId;
      if (!adId) return;
      const base = this.listCache.get(adId) || { ad_id: adId };
      base.contents = data.data || null;
      this.listCache.set(adId, base);
      this.pendingDetails.delete(adId);

      this.maybeFlushBatch();
    }
  }

  maybeFlushBatch() {
    if (this.hasMore) return;
    if (this.pendingDetails.size > 0) return;
    if (this.listCache.size === 0) return;

    const batch = {};
    for (const [adId, row] of this.listCache.entries()) {
      batch[adId] = row;
    }

    chrome.runtime
      .sendMessage({
        type: "clickedAds",
        adClickedData: batch,
      })
      .catch(() => {});

    // Reset for the next cycle
    this.listCache.clear();
    this.pendingDetails.clear();
    this.hasMore = null;
    this.lastItemRequested = null;
  }
}

window.FBAdActivityTracker = FBAdActivityTracker;
}
