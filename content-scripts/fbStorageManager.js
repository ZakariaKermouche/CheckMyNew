// content-scripts/fbStorageManager.js

class FBStorageManager {
  constructor() {
    this.queue = [];
    this.maxQueueSize = 50;
    this.sendInterval = 60000; // 60 seconds
    this.sendTimer = null;
    this.isSending = false;
    this.contextInvalidated = false;
    this.storageKey = "cmn_unsent_posts";
    this.fallbackStorageKey = "cmn_unsent_posts_fallback";
    this.sendTimeoutMs = 15000;
  }

  log(...args) {
    const debug =
      (window?.CMN?.config && window.CMN.config.debugMode) ||
      localStorage.getItem("CMN_DEBUG") === "1";
    if (debug) {
    }
  }

  // Initialize
  init() {
    // Load any unsent data from storage
    this.loadUnsentData();

    // Start periodic sending
    this.startPeriodicSend();

    // Send on page unload
    this.setupUnloadHandler();
  }

  // Add post to queue
  addPost(postData) {
    if (!postData) return;
    const queueItem = this.buildQueueItem(postData);
    this.queue.push(queueItem);

    this.log("Queued post", {
      id: queueItem.id || queueItem.post_id || queueItem.postId,
      source: queueItem.source,
      isSponsored: queueItem.isSponsored,
    });

    // Send if queue is full
    if (this.queue.length >= this.maxQueueSize) {
      this.sendData();
    }

    // Persist queue eagerly so data survives tab crashes/reloads.
    this.saveUnsentData();

    return true;
  }

  buildQueueItem(postData) {
    const payload = postData?.register_ad_payload || postData;
    return {
      id: postData?.id || null,
      post_id: postData?.post_id || postData?.id || null,
      source: postData?.source || null,
      isSponsored: Boolean(postData?.isSponsored),
      queuedAt: Date.now(),
      register_ad_payload: payload,
    };
  }

  // Update a queued post by id/post_id
  updatePost(id, updates = {}) {
    if (!id) return;

    const idx = this.queue.findIndex(
      (p) => p?.id === id || p?.post_id === id || p?.postId === id
    );

    if (idx === -1) return;

    this.queue[idx] = {
      ...this.queue[idx],
      ...updates,
      updatedAt: Date.now(),
    };
  }

  // Start periodic sending
  startPeriodicSend() {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
    }

    this.sendTimer = setInterval(() => {
      if (this.queue.length > 0) {
        this.sendData();
      }
    }, this.sendInterval);

  }

  // Stop periodic sending
  stopPeriodicSend() {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
  }

  // Send data to background
  async sendData() {
    if (this.isSending || this.queue.length === 0) {
      console.log("[CMN] ⏳ Already sending or queue empty");
      return;
    }

    this.isSending = true;
    const dataToSend = this.queue.splice(0, this.queue.length);
    const count = dataToSend.length;
    
    console.log("[CMN] 📤 Starting to send", count, "posts to background");

    try {
      if (!chrome?.runtime?.id) {
        throw new Error("Extension context invalidated");
      }

      const payloads = dataToSend
        .map((item) => item?.register_ad_payload || item)
        .filter(Boolean);

      const response = await this.sendMessageWithTimeout(
        {
          type: "REGISTER_AD_BATCH",
          payloads,
          metadata: {
            timestamp: Date.now(),
            pageUrl: window.location.href,
            count,
          },
        },
        this.sendTimeoutMs
      );
      console.log("[CMN] 📬 Backend batch response:", response);

      if (response?.ok) {
        console.log("[CMN] ✅ Successfully sent", count, "posts");
        this.applyDbIdMappings(dataToSend, response.mappings || []);
        const failedIdSet = new Set(
          Array.isArray(response.failedAdIds)
            ? response.failedAdIds.map((id) => String(id))
            : []
        );
        const failedIndexSet = new Set(
          Array.isArray(response.failedIndices)
            ? response.failedIndices
                .map((n) => Number(n))
                .filter((n) => Number.isInteger(n) && n >= 0)
            : []
        );

        const failedItems = dataToSend.filter((item, idx) => {
          if (failedIndexSet.has(idx)) return true;
          const payload = item?.register_ad_payload || item;
          const key =
            payload?.adanalyst_ad_id != null
              ? String(payload.adanalyst_ad_id)
              : payload?.html_ad_id != null
              ? String(payload.html_ad_id)
              : null;
          if (!key) return false;
          return failedIdSet.has(key);
        });

        const partialUnknownFailure =
          typeof response.total === "number" &&
          typeof response.count === "number" &&
          response.count < response.total &&
          failedItems.length === 0 &&
          failedIndexSet.size === 0;

        if (failedItems.length > 0 || partialUnknownFailure) {
          const toRequeue = partialUnknownFailure ? dataToSend : failedItems;
          console.warn(
            "[CMN] ⚠️ Backend failed to register some posts; requeueing",
            toRequeue.length
          );
          this.queue = [...toRequeue, ...this.queue];
          this.saveUnsentData();
        } else {
          this.clearStoredData();
        }
      } else {
        console.warn("[CMN] ⚠️  Backend returned unsuccessful response:", response);
        this.queue = [...dataToSend, ...this.queue];
        this.saveUnsentData();
      }
    } catch (error) {
      const msg = error?.message || String(error);
      
      if (msg.includes("Extension context invalidated") || 
          msg.includes("Receiving end does not exist")) {
        console.error("[CMN] ❌ Extension context lost - queuing for later");
        this.contextInvalidated = true;
      } else {
        console.error("[CMN] ❌ Send failed:", msg);
      }
      
      this.queue = [...dataToSend, ...this.queue];
      this.saveUnsentData();
    } finally {
      this.isSending = false;
    }
  }

  async sendMessageWithTimeout(message, timeoutMs) {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`sendMessage timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return Promise.race([chrome.runtime.sendMessage(message), timeoutPromise]);
  }

  applyDbIdMappings(dataToSend, mappings) {
    if (!Array.isArray(mappings) || mappings.length === 0) return;
    const byKey = new Map();
    for (const m of mappings) {
      const key = m?.adanalyst_ad_id ? String(m.adanalyst_ad_id) : null;
      if (!key || !m?.dbId) continue;
      byKey.set(key, String(m.dbId));
    }
    if (byKey.size === 0) return;

    for (const item of dataToSend) {
      const payload = item?.register_ad_payload;
      const key = payload?.adanalyst_ad_id
        ? String(payload.adanalyst_ad_id)
        : payload?.html_ad_id
        ? String(payload.html_ad_id)
        : null;
      if (!key || !byKey.has(key)) continue;
      const dbId = byKey.get(key);
      item.dbId = dbId;
      if (window?.CMN?.graphqlPostsMap && item?.post_id) {
        const post = window.CMN.graphqlPostsMap.get(item.post_id);
        if (post) {
          post.dbId = dbId;
        }
      }
    }
  }

  // Save unsent data to chrome.storage
  async saveUnsentData() {
    try {
      try {
        localStorage.setItem(this.fallbackStorageKey, JSON.stringify(this.queue));
      } catch (_) {}

      if (!chrome?.runtime?.id) {
        console.warn(
          "[CMN] ⚠️ chrome.runtime unavailable; saved queue only to localStorage fallback"
        );
        return;
      }

      console.log("[CMN] 💾 Saving", this.queue.length, "posts to storage");

      await chrome.storage.local.set({
        [this.storageKey]: this.queue,
        cmn_last_save: Date.now(),
      });

      console.log("[CMN] ✅ Saved successfully");
    } catch (error) {
      console.error("[CMN] ❌ Storage save error:", error.message, error);
    }
  }

  // Load unsent data from chrome.storage
  async loadUnsentData() {
    try {
      const result = await chrome.storage.local.get([this.storageKey]);
      const fromChrome = result[this.storageKey];
      if (fromChrome && Array.isArray(fromChrome)) {
        console.log("[CMN] 📥 Loaded", fromChrome.length, "posts from chrome.storage");
        this.queue = fromChrome;
        return;
      }

      const fallbackRaw = localStorage.getItem(this.fallbackStorageKey);
      if (fallbackRaw) {
        const parsed = JSON.parse(fallbackRaw);
        if (Array.isArray(parsed)) {
          this.queue = parsed;
          console.log("[CMN] 📥 Loaded", parsed.length, "posts from localStorage fallback");
          return;
        }
      }

      console.log("[CMN] 📭 No saved posts in storage");
    } catch (error) {
      console.error("[CMN] ❌ Storage load error:", error.message, error);
    }
  }

  // Clear stored data
  async clearStoredData() {
    try {
      await chrome.storage.local.remove([this.storageKey]);
      localStorage.removeItem(this.fallbackStorageKey);
    } catch (error) {
    }
  }

  // Setup handler for page unload
  setupUnloadHandler() {
    window.addEventListener("beforeunload", () => {
      if (this.queue.length > 0) {
        // Try to send immediately
        this.sendData();
        // Also save to storage as backup
        this.saveUnsentData();
      }
    });

    // Also handle visibility change
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.queue.length > 0) {
        this.saveUnsentData();
      }
    });
  }

  // Get queue stats
  getStats() {
    return {
      queueSize: this.queue.length,
      isSending: this.isSending,
      maxQueueSize: this.maxQueueSize,
    };
  }

  // Clear queue
  clearQueue() {
    this.queue = [];
    this.clearStoredData();
  }

  // Destroy
  destroy() {
    this.stopPeriodicSend();
    if (this.queue.length > 0) {
      this.saveUnsentData();
    }
  }
}

// Export
window.FBStorageManager = FBStorageManager;
