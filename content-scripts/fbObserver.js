// content-scripts/fbObserver.js
class FBObserver {
  constructor(onPostFound, onPostRemoved, options = {}) {
    this.observer = null;
    this.onPostFound = onPostFound;
    this.onPostRemoved = onPostRemoved;
    this.feedContainer = null;
    this.isObserving = false;

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    this.initialScanDelayMs = options.initialScanDelayMs || 1200;
    this.periodicScanIntervalMs = options.periodicScanIntervalMs || 2000;
    this.scanDebounceMs = options.scanDebounceMs || 180;

    this.initialScanTimer = null;
    this.periodicScanTimer = null;
    this.scanDebounceTimer = null;

    // Stable dedup/persistence layer. DOM is transient on Facebook.
    this.collectedPosts = new Map(); // postId -> metadata snapshot
    this.nodeToPostId = new WeakMap();

    this.stats = {
      scans: 0,
      candidates: 0,
      extracted: 0,
      duplicates: 0,
      updates: 0,
      failures: 0,
    };
  }

  findFeedContainer() {
    return document.body;
  }

  start() {
    if (this.isObserving) return;

    this.feedContainer = this.findFeedContainer();
    if (!this.feedContainer) {
      this.scheduleReconnect();
      return;
    }

    this.observer = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
    });

    this.observer.observe(this.feedContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "data-ft", "aria-label", "role"],
    });

    this.isObserving = true;
    this.reconnectAttempts = 0;

    if (this.initialScanTimer) clearTimeout(this.initialScanTimer);
    this.initialScanTimer = setTimeout(() => {
      if (this.isObserving) this.scanForPosts();
      this.initialScanTimer = null;
    }, this.initialScanDelayMs);

    this.periodicScanTimer = setInterval(() => {
      if (!this.isObserving) return;
      this.scanForPosts();
    }, this.periodicScanIntervalMs);
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.initialScanTimer) clearTimeout(this.initialScanTimer);
    if (this.periodicScanTimer) clearInterval(this.periodicScanTimer);
    if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
    this.initialScanTimer = null;
    this.periodicScanTimer = null;
    this.scanDebounceTimer = null;
    this.isObserving = false;
  }

  handleMutations(mutations) {
    let shouldScan = false;

    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        if ((mutation.addedNodes && mutation.addedNodes.length) || (mutation.removedNodes && mutation.removedNodes.length)) {
          shouldScan = true;
        }
      } else if (mutation.type === "attributes") {
        shouldScan = true;
      }

      if (mutation.removedNodes && this.onPostRemoved) {
        mutation.removedNodes.forEach((node) => {
          if (node?.nodeType === Node.ELEMENT_NODE && node.getAttribute?.("role") === "article") {
            this.onPostRemoved(node);
          }
        });
      }
    }

    if (shouldScan) this.scheduleScan();
  }

  scheduleScan() {
    if (this.scanDebounceTimer) return;
    this.scanDebounceTimer = setTimeout(() => {
      this.scanDebounceTimer = null;
      this.scanForPosts();
    }, this.scanDebounceMs);
  }

  scanForPosts() {
    if (!this.feedContainer) return;
    this.stats.scans += 1;

    const candidates = this.findCandidatePosts(this.feedContainer);
    this.stats.candidates += candidates.length;

    for (const node of candidates) {
      try {
        const incoming = this.extractPostData(node);
        if (!incoming?.postId) continue;

        const existing = this.collectedPosts.get(incoming.postId) || null;
        const merged = this.mergePost(existing, incoming);
        const changed = !existing || JSON.stringify(existing) !== JSON.stringify(merged);

        this.collectedPosts.set(incoming.postId, merged);
        this.nodeToPostId.set(node, incoming.postId);

        if (!existing) this.stats.extracted += 1;
        if (existing && changed) this.stats.updates += 1;
        if (existing && !changed) this.stats.duplicates += 1;

        if (( !existing || changed ) && this.onPostFound) {
          this.onPostFound(node);
        }
      } catch (error) {
        this.stats.failures += 1;
        console.debug("[CMN][FBObserver] extract failure", error);
      }
    }
  }

  findCandidatePosts(container) {
    const selectors = [
      '[role="article"]',
      'div[data-pagelet^="FeedUnit_"]',
      'div[data-ad-comet-preview="message"]',
      'a[href*="/posts/"]',
      'a[href*="/permalink/"]',
      'a[href*="story_fbid="]',
    ];

    const candidateSet = new Set();
    for (const selector of selectors) {
      container.querySelectorAll(selector).forEach((el) => {
        const article = el.getAttribute("role") === "article" ? el : el.closest('[role="article"]');
        if (article) candidateSet.add(article);
      });
    }

    return Array.from(candidateSet);
  }

  extractPostId(node) {
    if (!node) return null;

    const anchors = Array.from(node.querySelectorAll('a[href]'));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const match = href.match(/story_fbid=(\d+)/) || href.match(/\/posts\/(\d+)/) || href.match(/\/permalink\/(\d+)/) || href.match(/fbid=(\d+)/);
      if (match?.[1]) return match[1];
    }

    const dataFtEl = node.closest("[data-ft]") || node.querySelector("[data-ft]");
    const dataFt = dataFtEl?.getAttribute?.("data-ft") || "";
    const ftMatch = dataFt.match(/"top_level_post_id"\s*:\s*"(\d+)"/) || dataFt.match(/"mf_story_key"\s*:\s*"(\d+)"/);
    if (ftMatch?.[1]) return ftMatch[1];

    return null;
  }

  extractPostData(node) {
    const postId = this.extractPostId(node);
    if (!postId) return null;

    const messageNode =
      node.querySelector('[data-ad-rendering-role="story_message"]') ||
      node.querySelector('[data-ad-preview="message"]') ||
      node.querySelector('[data-ad-comet-preview="message"]');

    const message = (messageNode?.innerText || "").trim();
    const permalink = node.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="]')?.href || "";
    const author = node.querySelector('h2 a[role="link"], h3 a[role="link"], strong a[role="link"]')?.textContent?.trim() || "";

    return {
      postId,
      message,
      author,
      permalink,
      seenAt: Date.now(),
    };
  }

  mergePost(existing, incoming) {
    if (!existing) return { ...incoming };
    return {
      ...existing,
      ...incoming,
      message: incoming.message || existing.message || "",
      author: incoming.author || existing.author || "",
      permalink: incoming.permalink || existing.permalink || "",
      firstSeenAt: existing.firstSeenAt || existing.seenAt || incoming.seenAt,
      seenAt: incoming.seenAt || existing.seenAt,
    };
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10000);
    setTimeout(() => this.start(), delay);
  }

  reset() {
    this.stop();
    this.collectedPosts.clear();
    this.start();
  }

  getStats() {
    return {
      ...this.stats,
      observedPosts: this.collectedPosts.size,
      isObserving: this.isObserving,
    };
  }
}
