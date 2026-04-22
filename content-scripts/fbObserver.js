// content-scripts/fbObserver.js
function isPublicPost(post) {
  const svgs = post.querySelectorAll("svg");

  for (const svg of svgs) {
    const w = parseInt(svg.getAttribute("width") || "0", 10);
    const h = parseInt(svg.getAttribute("height") || "0", 10);

    if (w > 20 || h > 20) continue;
    if (svg.closest("a")) continue;

    const paths = svg.querySelectorAll("path");
    if (paths.length >= 3) {
      return true; // 🌍 public
    }
  }

  return false;
}

class FBObserver {
  constructor(onPostFound, onPostRemoved) {
    this.observer = null;
    this.onPostFound = onPostFound;
    this.onPostRemoved = onPostRemoved;
    this.feedContainer = null;
    this.isObserving = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.initialScanTimer = null;
    // Delay initial DOM scan slightly so bootstrap/GraphQL caches can warm up.
    this.initialScanDelayMs = 1500;
  }

  // Find the main feed container
  findFeedContainer() {
    return document.body;
  }

  // Start observing the feed
  start() {
    if (this.isObserving) {
      return;
    }

    this.feedContainer = this.findFeedContainer();

    if (!this.feedContainer) {
      this.scheduleReconnect();
      return;
    }

    // Setup mutation observer
    this.observer = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
    });

    this.observer.observe(this.feedContainer, {
      childList: true,
      subtree: true,
    });

    this.isObserving = true;
    this.reconnectAttempts = 0;

    if (this.initialScanTimer) clearTimeout(this.initialScanTimer);
    this.initialScanTimer = setTimeout(() => {
      // Only run if still observing.
      if (this.isObserving) this.processExistingPosts();
      this.initialScanTimer = null;
    }, this.initialScanDelayMs);
  }

  // Stop observing
  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.initialScanTimer) {
      clearTimeout(this.initialScanTimer);
      this.initialScanTimer = null;
    }
    this.isObserving = false;
  }

  // Process existing posts in feed
  processExistingPosts() {
    if (!this.feedContainer) return;

    const existingPosts = this.findAllPostElements(this.feedContainer);

    existingPosts.forEach((post) => {
      if (this.onPostFound) {
        this.onPostFound(post);
      }
    });
  }

  // Handle mutation events
  handleMutations(mutations) {
    const processedNodes = new Set();

    mutations.forEach((mutation) => {
      // Handle added nodes
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (processedNodes.has(node)) return;

        processedNodes.add(node);

        const found = new Set();

        // Check if node itself is a post
        if (this.isPostElement(node)) {
          found.add(node);
        }

        // Check for posts within the node
        const posts = this.findAllPostElements(node);
        posts.forEach((post) => found.add(post));

        found.forEach((post) => {
          if (processedNodes.has(post)) return;
          processedNodes.add(post);
          if (this.onPostFound) {
            this.onPostFound(post);
          }
        });
      });

      // Handle removed nodes (optional)
      mutation.removedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        if (this.isPostElement(node) && this.onPostRemoved) {
          this.onPostRemoved(node);
        }
      });
    });
  }

  // Find the real post root from a profile header
  findPostRootFromProfile(profileEl) {
    let el = profileEl;

    while (el && el !== document.body) {
      const hasMenu =
        el.querySelector('[aria-label="Actions for this post"]') ||
        el.querySelector('[aria-label="More actions"]');

      if (hasMenu) {
        return el;
      }

      el = el.parentElement;
    }

    return null;
  }

  // Find all post elements in a container
  findAllPostElements(container) {
    const markers = container.querySelectorAll(
      'div[data-ad-rendering-role="profile_name"], [data-ad-rendering-role="story_message"]'
    );

    const posts = [];

    markers.forEach((marker) => {
      const post = this.findPostContainerFromMarker(marker);
      if (post && this.isValidPostElement(post)) posts.push(post);
    });

    const deduped = [...new Set(posts)];
    return deduped;
  }

  // Check if element is a post
  isPostElement(element) {
    if (!element || !element.querySelector) return false;

    const hasMessage = !!element.querySelector(
      '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]'
    );
    const hasProfile = !!element.querySelector(
      '[data-ad-rendering-role="profile_name"], [role="link"][href*="/profile.php"]'
    );
    const hasToolbar = !!element.querySelector(
      '[aria-label="Actions for this post"]'
    );

    const isArticle = element.getAttribute("role") === "article";

    return hasProfile && (hasMessage || hasToolbar);
  }

  // Find post container from a marker element
  findPostContainerFromMarker(marker) {
    if (!marker) return null;

    // Fast path: FB often wraps posts in virtualized container
    const virtualized = marker.closest('div[data-virtualized="false"]');
    if (virtualized && this.isPostElement(virtualized)) return virtualized;

    // Walk up to find a container with expected markers
    let current = marker;
    let depth = 0;
    const maxDepth = 12;

    while (current && current !== document.body && depth < maxDepth) {
      if (this.isPostElement(current)) return current;
      current = current.parentElement;
      depth++;
    }

    return null;
  }

  // Basic sanity check for post-like nodes
  isValidPostElement(element) {
    if (!element) return false;
    const text = element.textContent?.trim() || "";
    const hasEnoughText = text.length > 20;
    const visible =
      (element.offsetWidth || 0) > 0 && (element.offsetHeight || 0) > 0;
    return hasEnoughText && visible;
  }

  // Schedule reconnection attempt
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);


    setTimeout(() => {
      this.start();
    }, delay);
  }

  // Reset observer (useful for navigation)
  reset() {
    this.stop();
    this.reconnectAttempts = 0;
    setTimeout(() => this.start(), 1000);
  }

  // Get status
  getStatus() {
    return {
      isObserving: this.isObserving,
      hasFeedContainer: !!this.feedContainer,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

// Export for use in other scripts
window.FBObserver = FBObserver;
