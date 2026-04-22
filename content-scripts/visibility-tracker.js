// content-scripts/visibility-tracker.js

class FBVisibilityTracker {
  constructor(onVisibleCallback) {
    this.onVisibleCallback = onVisibleCallback;
    this.observer = null;
    this.trackedElements = new Map(); // postId => { element, visibleAt }
    this.visiblePostIds = new Set();
    this.isRunning = false;
    this.intervalId = null;

    // Configuration
    this.visibilityThreshold = 0.2; // 20% visible OR 200px height
    this.visibilityMinHeight = 200;
    // Visible-time threshold is cumulative across small enter/leave flaps.
    this.visibilityDuration = 300; // ms
    this.checkInterval = 250;
  }

  /**
   * Start tracking post visibility
   */
  start() {
    if (this.isRunning) return;


    this.intervalId = setInterval(
      () => this.checkVisibility(),
      this.checkInterval
    );
    this.isRunning = true;
  }

  /**
   * Stop tracking
   */
  stop() {
    if (!this.isRunning) return;

    if (this.observer) {
      this.observer.disconnect();
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.trackedElements.forEach(({ timeoutId }) => {
      if (timeoutId) clearTimeout(timeoutId);
    });

    this.trackedElements.clear();
    this.visiblePostIds.clear();
    this.isRunning = false;

  }

  /**
   * Register a post element for visibility tracking
   * @param {HTMLElement} element - The post element
   * @param {string} postId - The post ID from GraphQL
   */
  track(element, postId) {
    if (!element || !postId) {
      return;
    }

    if (this.trackedElements.has(postId)) {
      // FB may recycle DOM nodes; refresh the element pointer so visibility checks stay accurate.
      const tracked = this.trackedElements.get(postId);
      if (tracked && tracked.element !== element) {
        tracked.element = element;
      }
      return;
    }

    if (!this.isRunning) {
    }

    // Store element reference
    this.trackedElements.set(postId, {
      element,
      visibleAt: null,
      visibleSince: null,
      visibleStart: null,
      totalVisibleMs: 0,
      timeoutId: null,
      wasVisible: false,
      seenFired: false,
    });
  }

  /**
   * Remap a tracked element from a temporary id to the real post id.
   * Keeps visibility state and avoids double-tracking.
   */
  remapPostId(oldPostId, newPostId) {
    if (!oldPostId || !newPostId || oldPostId === newPostId) return;
    const tracked = this.trackedElements.get(oldPostId);
    if (!tracked) return;


    if (this.trackedElements.has(newPostId)) {
      // Already tracked under the real id; drop the temp id.
      this.trackedElements.delete(oldPostId);
      this.visiblePostIds.delete(oldPostId);
      return;
    }

    this.trackedElements.set(newPostId, tracked);
    this.trackedElements.delete(oldPostId);

    if (this.visiblePostIds.has(oldPostId)) {
      this.visiblePostIds.delete(oldPostId);
      this.visiblePostIds.add(newPostId);
    }
  }

  checkVisibility() {
    const now = Date.now();

    this.trackedElements.forEach((tracked, postId) => {
      const visibleState = this.getVisibleState(tracked.element);

      if (!visibleState) {
        this.handlePostLeftViewport(postId, tracked, now);
        return;
      }

      const { visibleHeight, totalHeight } = visibleState;
      const visibleFraction = totalHeight > 0 ? visibleHeight / totalHeight : 0;
      const isVisibleEnough =
        visibleFraction >= this.visibilityThreshold ||
        visibleHeight >= this.visibilityMinHeight;

      if (isVisibleEnough) {
        if (!tracked.visibleSince) {
          tracked.visibleSince = now;
          tracked.visibleStart = now;
        }

        const currentStreakMs = tracked.visibleSince ? now - tracked.visibleSince : 0;
        const totalMs = (tracked.totalVisibleMs || 0) + currentStreakMs;
        if (!tracked.seenFired && totalMs >= this.visibilityDuration) {
          this.fireSeen(postId, tracked, now);
        }
      } else {
        this.handlePostLeftViewport(postId, tracked, now);
      }
    });
  }

  /**
   * Handle post becoming visible in viewport
   * @param {string} postId
   * @param {Object} tracked
   */
  handlePostBecameVisible(postId, tracked) {
    if (tracked.wasVisible) {
      return; // Already fired visibility event for this post
    }


    // Set a timeout to confirm it stays visible for the required duration
    tracked.timeoutId = setTimeout(() => {
      if (!this.visiblePostIds.has(postId)) {
        this.visiblePostIds.add(postId);

        // Fire callback with all currently visible posts
        this.onVisibleCallback(Array.from(this.visiblePostIds));
      }
    }, this.visibilityDuration);
  }

  /**
   * Handle post leaving viewport
   * @param {string} postId
   * @param {Object} tracked
   */
  handlePostLeftViewport(postId, tracked, now = Date.now()) {
    if (tracked.visibleSince) {
      const visibleMs = now - tracked.visibleSince;
      tracked.totalVisibleMs = (tracked.totalVisibleMs || 0) + Math.max(0, visibleMs);
      if (!tracked.seenFired && visibleMs >= this.visibilityDuration) {
        this.fireSeen(postId, tracked, now);
      }
    }
    if (tracked.visibleStart) {
      window.dispatchEvent(
        new CustomEvent("CMN_POST_VISIBILITY", {
          detail: {
            postId,
            started_ts: tracked.visibleStart,
            end_ts: now,
          },
        })
      );
      try {
        if (chrome?.runtime?.id) {
          chrome.runtime
            .sendMessage({
              type: "postVisibility",
              postId,
              started_ts: tracked.visibleStart,
              end_ts: now,
            })
            .catch(() => {});
        }
      } catch (_) {}
    }
    tracked.visibleSince = null;
    tracked.visibleStart = null;
  }

  fireSeen(postId, tracked, now) {
    if (this.visiblePostIds.has(postId)) return;
    this.visiblePostIds.add(postId);
    tracked.seenFired = true;
    tracked.visibleAt = now;
    this.onVisibleCallback([postId]);
  }

  /**
   * Extract postId from element (tries multiple strategies)
   * @param {HTMLElement} element
   * @returns {string|null}
   */
  findPostIdFromElement(element) {
    // Strategy 1: Look through our tracked elements
    for (const [postId, tracked] of this.trackedElements.entries()) {
      if (tracked.element === element) {
        return postId;
      }
    }

    // Strategy 2: Try to extract from element attributes
    const attributes = [
      "data-post-id",
      "data-ftid",
      "data-feed-item-id",
      "data-timeline-id",
      "data-deferred-id",
    ];

    for (const attr of attributes) {
      const value = element.getAttribute(attr);
      if (value) return value;
    }

    // Strategy 3: Check parent elements
    let parent = element.parentElement;
    let depth = 0;
    while (parent && depth < 5) {
      for (const attr of attributes) {
        const value = parent.getAttribute(attr);
        if (value) return value;
      }
      parent = parent.parentElement;
      depth++;
    }

    return null;
  }

  getVisibleState(element) {
    if (!element || !element.getBoundingClientRect) return null;
    const rect = element.getBoundingClientRect();
    const viewHeight =
      window.innerHeight || document.documentElement.clientHeight;

    const isAbove = rect.bottom <= 0;
    const isBelow = rect.top >= viewHeight;
    if (isAbove || isBelow) return null;

    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.bottom, viewHeight);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const totalHeight = rect.height || element.offsetHeight || 0;

    return { visibleHeight, totalHeight };
  }

  /**
   * Untrack a post
   * @param {string} postId
   */
  untrack(postId) {
    const tracked = this.trackedElements.get(postId);
    if (tracked) {
      if (tracked.timeoutId) {
        clearTimeout(tracked.timeoutId);
      }
      this.trackedElements.delete(postId);
    }
  }

  /**
   * Get all currently visible posts
   * @returns {string[]}
   */
  getVisiblePosts() {
    return Array.from(this.visiblePostIds);
  }

  /**
   * Get tracking stats
   * @returns {Object}
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      trackedElements: this.trackedElements.size,
      visiblePosts: this.visiblePostIds.size,
      threshold: this.visibilityThreshold,
      duration: this.visibilityDuration,
    };
  }
}
