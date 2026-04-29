// content-scripts/fbObserver.js
class FBObserver {
  constructor(onPostFound, onPostRemoved, options = {}) {
    this.observer = null;
    this.onPostFound = onPostFound;
    this.onPostRemoved = onPostRemoved;
    this.isObserving = false;

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    this.initialScanDelayMs = options.initialScanDelayMs || 1200;
    this.periodicScanIntervalMs = options.periodicScanIntervalMs || 2000;

    this.initialScanTimer = null;
    this.periodicScanTimer = null;
    this.healthTimer = null;
    this.boundScrollHandler = null;

    this.scanScheduled = false;
    this.scanInProgress = false;

    // Dedup + persistence MUST be ID-based (not node-based) for FB virtualization.
    this.collectedPosts = new Map(); // post_id -> post snapshot

    this.stats = {
      scans: 0,
      extracted: 0,
      duplicates: 0,
      updates: 0,
      failures: 0,
    };
  }

  start() {
    if (this.isObserving) return;
    if (!document.body) {
      this.scheduleReconnect();
      return;
    }

    this.observer = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
    });
    this.observer.observe(document.body, { childList: true, subtree: true });

    this.isObserving = true;
    this.reconnectAttempts = 0;

    this.initialScanTimer = setTimeout(() => {
      if (this.isObserving) this.scanForPosts("initial");
      this.initialScanTimer = null;
    }, this.initialScanDelayMs);

    this.periodicScanTimer = setInterval(() => {
      if (!this.isObserving) return;
      this.scheduleScan("periodic");
    }, this.periodicScanIntervalMs);

    this.boundScrollHandler = () => this.scheduleScan("scroll");
    window.addEventListener("scroll", this.boundScrollHandler, { passive: true });

    this.healthTimer = setInterval(() => {
      if (!this.isObserving) return;
      if (!this.observer || !document.body) {
        console.debug("[CMN][FBObserver] health check failed, reconnecting");
        this.stop();
        this.start();
      }
    }, 5000);
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.initialScanTimer) clearTimeout(this.initialScanTimer);
    if (this.periodicScanTimer) clearInterval(this.periodicScanTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.boundScrollHandler) {
      window.removeEventListener("scroll", this.boundScrollHandler);
    }

    this.initialScanTimer = null;
    this.periodicScanTimer = null;
    this.healthTimer = null;
    this.boundScrollHandler = null;

    this.scanScheduled = false;
    this.scanInProgress = false;
    this.isObserving = false;
  }

  handleMutations(mutations) {
    console.debug("[CMN][FBObserver] mutation batch", { count: mutations.length });
    this.scheduleScan("mutation");

    if (this.onPostRemoved) {
      for (const mutation of mutations) {
        mutation.removedNodes.forEach((node) => {
          if (node?.nodeType === Node.ELEMENT_NODE && node.getAttribute?.("role") === "article") {
            this.onPostRemoved(node);
          }
        });
      }
    }
  }

  scheduleScan(source = "unknown") {
    if (this.scanScheduled) return;
    this.scanScheduled = true;

    requestAnimationFrame(() => {
      this.scanScheduled = false;
      this.scanForPosts(source);
    });
  }

  scanForPosts(source = "manual") {
    if (this.scanInProgress) return;
    this.scanInProgress = true;

    try {
      this.stats.scans += 1;

      const articles = this.findCandidatePosts();
      const extractedPostIds = [];
      const duplicateIds = [];
      const newlyAddedIds = [];
      const failedExtractions = [];

      for (const node of articles) {
        let incoming = null;
        try {
          incoming = this.extractPostData(node);
        } catch (error) {
          this.stats.failures += 1;
          failedExtractions.push(String(error?.message || error));
          continue;
        }

        if (!incoming?.postId) {
          failedExtractions.push("missing_post_id");
          continue;
        }

        extractedPostIds.push(incoming.postId);
        const existing = this.collectedPosts.get(incoming.postId) || null;
        const merged = this.mergePost(existing, incoming);
        const changed = !existing || JSON.stringify(existing) !== JSON.stringify(merged);

        this.collectedPosts.set(incoming.postId, merged);

        if (!existing) {
          this.stats.extracted += 1;
          newlyAddedIds.push(incoming.postId);
        } else if (changed) {
          this.stats.updates += 1;
        } else {
          this.stats.duplicates += 1;
          duplicateIds.push(incoming.postId);
        }

        if ((!existing || changed) && this.onPostFound) {
          this.onPostFound(node);
        }
      }

      console.log("[collector] scan", {
        source,
        totalArticlesFound: articles.length,
        extractedPostIds,
        duplicateIds,
        newlyAddedIds,
        failedExtractions,
        mountedArticlesCount: document.querySelectorAll('[role="article"]').length,
      });
    } finally {
      this.scanInProgress = false;
    }
  }

  findCandidatePosts() {
    return Array.from(document.querySelectorAll('[role="article"]'));
  }

  extractPostId(node) {
    if (!node) return null;

    const anchors = Array.from(node.querySelectorAll("a[href]"));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const match =
        href.match(/[?&]story_fbid=(\d+)/) ||
        href.match(/\/posts\/(\d+)/) ||
        href.match(/\/permalink\/(\d+)/);
      if (match?.[1]) return match[1];
    }



    // Fallback: story.php links often carry both story_fbid and id (page/user id).
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (!href.includes("story.php")) continue;
      const match = href.match(/[?&]story_fbid=(\d+)/);
      if (match?.[1]) return match[1];
    }
    const dataFtEl = node.closest("[data-ft]") || node.querySelector("[data-ft]");
    const dataFt = dataFtEl?.getAttribute?.("data-ft") || "";
    const ftMatch =
      dataFt.match(/"top_level_post_id"\s*:\s*"(\d+)"/) ||
      dataFt.match(/"mf_story_key"\s*:\s*"(\d+)"/);
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

    return {
      postId,
      message: (messageNode?.innerText || "").trim(),
      permalink:
        node.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="]')?.href || "",
      seenAt: Date.now(),
    };
  }

  mergePost(existing, incoming) {
    if (!existing) return { ...incoming, firstSeenAt: incoming.seenAt };
    return {
      ...existing,
      ...incoming,
      message: incoming.message || existing.message || "",
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
}
