// content-scripts/explanation-fetcher.js

class ExplanationFetcher {
  constructor() {
    this.fetchQueue = []; // Queue of posts waiting for explanation
    this.activeRequests = new Map(); // postId => requestPromise
    this.explanationCache = new Map(); // Cache fetched explanations
    this.pendingGraphqlRequests = new Map(); // requestId => {resolve,reject,timeout}
    this.lastFetchTime = 0;
    this.rateLimitMs = 2000; // Wait 2 seconds between fetches
    this.isProcessing = false;

    // Listen for messages from content script
    this.setupMessageListener();
    this.setupPageBridgeListener();
  }

  /**
   * Best-effort extraction of the explanation URL for a sponsored post.
   * This is MV2-style: resolve an explanation URL, then let the background
   * offscreen pipeline fetch+parse+send it.
   *
   * @param {HTMLElement} postElement
   * @param {Object} ctx
   * @returns {Promise<string|null>}
   */
  async getExplanationUrlFromPostElement(postElement, ctx = {}) {
    try {
      if (!postElement) return null;

      const menuButton = this.findMenuButton(postElement);
      if (!menuButton) {
        return null;
      }

      menuButton.click();

      const menu = await this.waitForMenuOrMenuItem();
      if (!menu) {
        return null;
      }

      const url = this.extractExplanationUrlFromMenu(menu);
      this.closeOpenMenuOrDialog();

      if (!url) {
        return null;
      }

      return url;
    } catch (e) {
      return null;
    }
  }

  /**
   * Open the menu and click "Why am I seeing this ad?" quickly to prime doc_id.
   * Best-effort and tries to minimize UI impact (opens menu, clicks item, closes).
   *
   * @param {HTMLElement} postElement
   * @param {Object} ctx
   * @returns {Promise<boolean>}
   */
  async primeDocIdSilently(postElement, ctx = {}) {
    try {
      if (!postElement) return false;

      const cleanupStyle = this.injectPrimeHideStyle();
      this.enableWaistDialogSilence();

      const menuButton = this.findMenuButton(postElement);
      if (!menuButton) {
        this.disableWaistDialogSilence();
        cleanupStyle();
        return false;
      }

      menuButton.click();

      const menuOrItem = await this.waitForMenuOrMenuItem(1000, 10);
      if (!menuOrItem) {
        this.disableWaistDialogSilence();
        cleanupStyle();
        return false;
      }

      const menuRoot = menuOrItem.closest('[role="menu"]') || menuOrItem;
      if (menuRoot?.style) {
        menuRoot.style.setProperty("display", "none", "important");
      }
      const menuShell = menuRoot?.closest?.(
        ".xu96u03.xm80bdy.x10l6tqk.x13vifvy"
      );
      if (menuShell?.style) {
        menuShell.style.setProperty("display", "none", "important");
      }
      const item = this.findWhyAmISeeingThisMenuItem(menuRoot);
      if (!item) {
        this.closeOpenMenuOrDialog();
        this.disableWaistDialogSilence();
        cleanupStyle();
        return false;
      }

      const clickable =
        item.closest('[role="menuitem"], a[href], button') || item;

      if (clickable?.tagName === "A") {
        clickable.addEventListener(
          "click",
          (e) => {
            e.preventDefault();
          },
          { capture: true, once: true }
        );
      }

      clickable.click();
      this.silenceWaistDialog();
      await this.sleep(600);
      this.closeOpenMenuOrDialog();
      this.disableWaistDialogSilence();
      cleanupStyle();
      return true;
    } catch (e) {
      this.closeOpenMenuOrDialog();
      this.removePrimeHideStyle();
      this.disableWaistDialogSilence();
      return false;
    }
  }

  injectPrimeHideStyle() {
    const id = "cmn-prime-hide-menu";
    const existing = document.getElementById(id);
    if (existing) return () => {};
    const style = document.createElement("style");
    style.id = id;
    const hideLight = [
      'html.cmn-silence-waist [role="dialog"]',
      'html.cmn-silence-waist [aria-label="Why you saw this ad"]',
      'html.cmn-silence-waist [aria-label="Why you saw this ad"] *',
      "html.cmn-silence-waist .__fb-dark-mode.x1n2onr6.xzkaem6",
      "html.cmn-silence-waist .__fb-dark-mode.x1qjc9v5.x9f619.x78zum5.xdt5ytf.xl56j7k.x1c4vz4f.xg6iff7",
      "html.cmn-silence-waist .x1uvtmcs.x4k7w5x.x1h91t0o.x1beo9mf",
      "html.cmn-silence-waist .xu96u03.xm80bdy.x10l6tqk.x13vifvy",
      // Menu container and items
      '[role="menu"]',
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      // Observed menu wrappers from provided DOM
      ".xu96u03.xm80bdy.x10l6tqk.x13vifvy",
      ".x1uvtmcs.x4k7w5x.x1h91t0o.x1beo9mf",
      '[aria-label="Feed story"][role="menu"]',
      // Observed dialog wrapper for "Why you saw this ad"
      '[aria-label="Why you saw this ad"]',
      ".__fb-dark-mode.x1n2onr6.xzkaem6",
      ".__fb-dark-mode.x1qjc9v5.x9f619.x78zum5.xdt5ytf.xl56j7k.x1c4vz4f.xg6iff7",
      ".x1cy8zhl.x9f619.x78zum5.xl56j7k.x2lwn1j",
      'a[href*="/adpreferences/?entry_product=waist"]',
      'a[href*="/adpreferences/"]',
    ];
    const hideStrong = [
      "html.cmn-silence-waist .xu96u03.xm80bdy.x10l6tqk.x13vifvy",
      "html.cmn-silence-waist .x1uvtmcs.x4k7w5x.x1h91t0o.x1beo9mf",
      'html.cmn-silence-waist [role="menu"]',
      'html.cmn-silence-waist [role="dialog"]',
      'html.cmn-silence-waist [aria-label="Feed story"][role="menu"]',
      "html.cmn-silence-waist .x1n2onr6.xcxhlts.xe5xk9h",
      "html.cmn-silence-waist .x1qjc9v5.x7sf2oe.x78zum5.xdt5ytf.x1n2onr6.x1al4vs7",
      "html.cmn-silence-waist .xb57i2i.x1q594ok.x5lxg6s",
      "html.cmn-silence-waist .x1ey2m1c.xtijo5x.x1o0tod.xixxii4.x13vifvy.x1h0vfkc",
    ];
    style.textContent = hideLight
      .map(
        (sel) =>
          `${sel}{opacity:0!important;visibility:hidden!important;pointer-events:none!important;}`
      )
      .join("")
      .concat(
        hideStrong.map((sel) => `${sel}{display:none!important;}`).join("")
      );
    document.documentElement.appendChild(style);
    return () => {
      style.remove();
    };
  }

  silenceWaistDialog(timeoutMs = 1500) {
    const hideDialog = (root) => {
      if (!root || root.nodeType !== 1) return;
      const nodes = [];
      if (root.matches?.('[role="dialog"]')) nodes.push(root);
      nodes.push(...(root.querySelectorAll?.('[role="dialog"]') || []));

      for (const dialog of nodes) {
        const hasHeading =
          dialog.querySelector?.(
            '[role="heading"][aria-label="Why you saw this ad"]'
          ) ||
          dialog
            .querySelector?.('[role="heading"] span')
            ?.textContent?.toLowerCase()
            .includes("why you saw this ad");
        const hasLink =
          dialog.querySelector?.(
            'a[href*="/adpreferences/?entry_product=waist"]'
          ) || dialog.querySelector?.('a[href*="/adpreferences/"]');
        if (hasHeading || hasLink) {
          dialog.style.setProperty("display", "none", "important");
          const closeBtn = dialog.querySelector?.(
            '[aria-label="Close"][role="button"]'
          );
          if (closeBtn) {
            closeBtn.click();
          }
          const darkRoot = dialog.closest?.(".__fb-dark-mode");
          if (darkRoot) {
            darkRoot.style.setProperty("display", "none", "important");
          }
          const container = dialog.closest?.(
            ".x1uvtmcs.x4k7w5x.x1h91t0o.x1beo9mf"
          );
          if (container) {
            container.style.setProperty("display", "none", "important");
          }
          const shell = dialog.closest?.(
            ".__fb-dark-mode.x1qjc9v5.x9f619.x78zum5.xdt5ytf.xl56j7k.x1c4vz4f.xg6iff7"
          );
          if (shell) {
            shell.style.setProperty("display", "none", "important");
          }
          let p = dialog.parentElement;
          for (let i = 0; p && i < 3; i += 1) {
            p.style.setProperty("display", "none", "important");
            p = p.parentElement;
          }
        }
      }
    };

    hideDialog(document);

    let rafId = null;
    const start = Date.now();
    const pump = () => {
      hideDialog(document);
      if (Date.now() - start < timeoutMs) {
        rafId = requestAnimationFrame(pump);
      }
    };
    pump();

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes || []) {
          hideDialog(node);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    setTimeout(() => {
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    }, timeoutMs);
  }

  enableWaistDialogSilence() {
    document.documentElement.classList.add("cmn-silence-waist");
  }

  disableWaistDialogSilence() {
    document.documentElement.classList.remove("cmn-silence-waist");
  }

  removePrimeHideStyle() {
    const id = "cmn-prime-hide-menu";
    const style = document.getElementById(id);
    if (style) style.remove();
  }

  findWhyAmISeeingThisMenuItem(menuEl) {
    if (!menuEl) return null;
    const items = Array.from(
      menuEl.querySelectorAll(
        '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], a[href], button'
      )
    );

    const patterns = [
      "why am i seeing this ad",
      "why am i seeing this post",
      "why am i seeing this",
      "why this ad",
      "why am i seeing",
      "ad preferences",
      "ads preferences",
      "why this",
    ];

    let best = null;
    let bestScore = -1;

    for (const el of items) {
      const text = (el.textContent || "").toLowerCase().trim();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase().trim();
      const testId = (el.getAttribute("data-testid") || "")
        .toLowerCase()
        .trim();
      const href = (el.getAttribute("href") || "").toLowerCase();

      let score = 0;
      if (patterns.some((p) => text.includes(p))) score += 5;
      if (patterns.some((p) => aria.includes(p))) score += 4;
      if (testId.includes("why") && testId.includes("ad")) score += 3;
      if (
        href.includes("/ads/preferences") ||
        href.includes("/ads/about") ||
        href.includes("ad_preferences") ||
        href.includes("ads/preferences") ||
        href.includes("ads/about")
      ) {
        score += 2;
      }

      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    return bestScore > 0 ? best : null;
  }

  findMenuButton(postElement) {
    // Prefer explicit menu buttons.
    const selectors = [
      '[role="button"][aria-haspopup="menu"]',
      'div[role="button"][aria-label*="Options"]',
      'div[role="button"][aria-label*="options"]',
      'div[role="button"][aria-label*="Actions"]',
      'div[role="button"][aria-label*="actions"]',
      'div[role="button"][aria-label*="More"]',
      'div[role="button"][aria-label*="more"]',
      'button[aria-haspopup="menu"]',
    ];

    for (const sel of selectors) {
      const el = postElement.querySelector(sel);
      if (el) return el;
    }

    // Fallback: scan buttons for a likely "..." control.
    const buttons = Array.from(
      postElement.querySelectorAll('[role="button"],button')
    );
    const scored = buttons
      .map((el) => {
        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        const hasSvg = !!el.querySelector("svg");
        const score =
          (label.includes("option") ? 3 : 0) +
          (label.includes("action") ? 2 : 0) +
          (label.includes("menu") ? 2 : 0) +
          (label.includes("more") ? 1 : 0) +
          (hasSvg ? 1 : 0);
        return { el, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.el || null;
  }

  findOpenMenu() {
    const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(
      (m) => {
        // Visible menu (best-effort)
        const rect = m.getBoundingClientRect?.();
        return rect && rect.width > 0 && rect.height > 0;
      }
    );
    return menus[menus.length - 1] || null;
  }

  async waitForMenuOrMenuItem(timeoutMs = 1000, intervalMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const menu = this.findOpenMenu();
      if (menu) return menu;

      // Sometimes menuitems render without role="menu" on the container.
      const menuItem = Array.from(
        document.querySelectorAll('[role="menuitem"]')
      ).find((el) => (el.textContent || "").trim().length > 0);
      if (menuItem) return menuItem.closest('[role="menu"]') || menuItem;

      await this.sleep(intervalMs);
    }
    return null;
  }

  extractExplanationUrlFromMenu(menuEl) {
    const anchors = Array.from(menuEl.querySelectorAll("a[href]"));
    const patterns = [
      "/ads/preferences/",
      "/ads/about/",
      "ad_preferences",
      "ads/preferences",
      "ads/about",
    ];

    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const abs = new URL(href, window.location.href).toString();
      if (patterns.some((p) => abs.includes(p))) {
        return abs;
      }
    }

    return null;
  }

  closeOpenMenuOrDialog() {
    // Try pressing Escape to close menu/dialog.
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
        })
      );
    } catch {}
  }

  /**
   * Setup message listener for fetch requests
   */
  setupMessageListener() {
    if (typeof chrome === "undefined") return;

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === "FETCH_EXPLANATION") {
        this.fetchExplanation(request.postId, request.isSponsored)
          .then((data) => {
            sendResponse({ success: true, data });
          })
          .catch((error) => {
            sendResponse({ success: false, error: error.message });
          });

        // Return true to indicate async response
        return true;
      }
    });
  }

  /**
   * Listen for explanation results from page context
   */
  setupPageBridgeListener() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.source !== "CMN_PAGE") return;
      if (data.type !== "CMN_EXPLANATION_RESPONSE") return;

      const pending = this.pendingGraphqlRequests.get(data.requestId);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pendingGraphqlRequests.delete(data.requestId);

      if (data.ok) {
        pending.resolve(data.responseText);
      } else {
        pending.reject(new Error(data.error || "graphql_explanation_failed"));
      }
    });
  }

  /**
   * Fetch explanation for a post
   * @param {string} postId
   * @param {boolean} isSponsored
   * @returns {Promise<Object>}
   */
  async fetchExplanation(postId, isSponsored) {
    // Return cached explanation if available
    if (this.explanationCache.has(postId)) {
      return this.explanationCache.get(postId);
    }

    // If already fetching, return the same promise
    if (this.activeRequests.has(postId)) {
      return this.activeRequests.get(postId);
    }

    // Create fetch promise
    const fetchPromise = this.performFetch(postId, isSponsored);

    // Store it to prevent duplicates
    this.activeRequests.set(postId, fetchPromise);

    try {
      const result = await fetchPromise;
      this.explanationCache.set(postId, result);
      return result;
    } finally {
      this.activeRequests.delete(postId);
    }
  }

  /**
   * Perform the actual explanation fetch
   * @param {string} postId
   * @param {boolean} isSponsored
   * @returns {Promise<Object>}
   */
  async performFetch(postId, isSponsored) {
    // Rate limiting
    const timeSinceLastFetch = Date.now() - this.lastFetchTime;
    if (timeSinceLastFetch < this.rateLimitMs) {
      const waitTime = this.rateLimitMs - timeSinceLastFetch;
      await this.sleep(waitTime);
    }

    this.lastFetchTime = Date.now();


    if (!isSponsored) {
      return null;
    }

    // Strategy 1: Try to find and click the "Why am I seeing this?" button
    const explanation = await this.fetchViaExplanationButton(postId);

    if (explanation) {
      return explanation;
    }

    // Strategy 2: Try to infer explanation from GraphQL data
    // (if you have access to original GraphQL response)
    const inferred = await this.inferExplanationFromGraphQL(postId);

    if (inferred) {
      return inferred;
    }

    return null;
  }

  /**
   * Find and interact with the "Why am I seeing this?" button
   * @param {string} postId
   * @returns {Promise<Object>}
   */
  async fetchViaExplanationButton(postId) {
    try {
      // Find the post element in DOM
      const postElement = document.querySelector(
        `[data-post-id="${postId}"], [data-ftid*="${postId}"], article[data-feed-item-id*="${postId}"]`
      );

      if (!postElement) {
        return null;
      }

      // Look for "..." menu button
      const menuButton = this.findMenuButton(postElement);

      if (!menuButton) {
        return null;
      }


      // Click the menu button
      menuButton.click();

      // Wait for menu to appear
      await this.sleep(500);

      // Look for "Why am I seeing this?" option in the menu
      const menu = this.findOpenMenu();
      const menuItems = Array.from(
        (menu || document).querySelectorAll('[role="menu"]')
      );
      const whyButton = menuItems.find((el) =>
        /why am i seeing this/i.test(el.textContent || "")
      );

      if (!whyButton) {
        return null;
      }

      whyButton.click();

      // Wait for explanation modal to appear
      await this.sleep(1000);

      // Extract explanation from modal
      const explanation = this.extractExplanationFromModal();

      // Close modal (click outside or find close button)
      this.closeExplanationModal();

      return explanation;
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract explanation text from the modal
   * @returns {Object}
   */
  extractExplanationFromModal() {
    try {
      // Try multiple selectors for the explanation modal
      const modal = document.querySelector(
        '[role="dialog"], .xhk5a, [class*="modal"]'
      );

      if (!modal) {
        return null;
      }

      const explanationText = modal.textContent;
      const advertisers = this.extractAdvertisersFromModal(modal);
      const reasons = this.extractReasonsFromModal(modal);

      const data = {
        explanation_text: explanationText,
        advertisers: advertisers,
        reasons: reasons,
        fetched_at: Date.now(),
      };


      return data;
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract advertiser names from explanation modal
   * @param {HTMLElement} modal
   * @returns {string[]}
   */
  extractAdvertisersFromModal(modal) {
    try {
      const advertisers = [];
      const advertiserElements = modal.querySelectorAll(
        '[class*="advertiser"], [class*="sponsor"], [class*="business"]'
      );

      advertiserElements.forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length > 0) {
          advertisers.push(text);
        }
      });

      return advertisers;
    } catch (error) {
      return [];
    }
  }

  /**
   * Extract reasons from explanation modal
   * @param {HTMLElement} modal
   * @returns {string[]}
   */
  extractReasonsFromModal(modal) {
    try {
      const reasons = [];

      // Look for bullet points or reason elements
      const reasonElements = modal.querySelectorAll(
        'li, [class*="reason"], [class*="because"], p'
      );

      reasonElements.forEach((el) => {
        const text = el.textContent?.trim();
        // Filter out very short text and duplicates
        if (text && text.length > 20 && !reasons.includes(text)) {
          reasons.push(text);
        }
      });

      return reasons;
    } catch (error) {
      return [];
    }
  }

  /**
   * Close the explanation modal
   */
  closeExplanationModal() {
    try {
      // Try to find close button
      const closeButton = document.querySelector(
        '[aria-label="Close"], [class*="closeButton"]'
      );

      if (closeButton) {
        closeButton.click();
        return;
      }

      // Try pressing Escape key as fallback
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
        })
      );
    } catch (error) {
    }
  }

  /**
   * Infer explanation from GraphQL data
   * (This depends on what data you captured in GraphQL interceptor)
   * @param {string} postId
   * @returns {Promise<Object>}
   */
  async inferExplanationFromGraphQL(postId) {
    try {
      // If you have a GraphQL store with cached data, try to use it
      const store = window.__CMN_GRAPHQL_STORE__;

      if (!store) {
        return null;
      }

      const postData = store.get(postId);

      if (!postData) {
        return null;
      }

      // Try to extract explanation fields from GraphQL response
      // This depends on Facebook's GraphQL schema
      const explanation = {
        explanation_text: postData.ad_explanation || null,
        advertisers: postData.advertiser || null,
        reasons: postData.ad_targeting_reasons || null,
        fetched_at: Date.now(),
        source: "graphql",
      };

      if (explanation.explanation_text || explanation.advertisers) {
        return explanation;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Fetch explanation via direct GraphQL request in page context
   * @param {string} adId
   * @param {string} clientToken
   * @returns {Promise<Object|null>}
   */
  async fetchExplanationViaGraphQLRequest(adId, clientToken) {
    if (!adId || !clientToken) return null;

    const requestId = `cmn-exp-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

    const responseText = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingGraphqlRequests.delete(requestId);
        reject(new Error("graphql_explanation_timeout"));
      }, 8000);

      this.pendingGraphqlRequests.set(requestId, { resolve, reject, timeout });

      window.postMessage(
        {
          source: "CMN_CONTENT",
          type: "CMN_FETCH_AD_EXPLANATION",
          requestId,
          adId,
          clientToken,
        },
        "*"
      );
    });

    return this.parseGraphQLExplanationResponse(responseText);
  }

  /**
   * Best-effort parsing of GraphQL explanation response
   * @param {string} responseText
   * @returns {Object|null}
   */
  parseGraphQLExplanationResponse(responseText) {
    try {
      if (!responseText) return null;
      const cleaned = responseText.startsWith("for (;;);")
        ? responseText.replace("for (;;);", "")
        : responseText;
      const json = JSON.parse(cleaned);
      const data = json?.data || json;

      const reasons = new Set();
      const advertisers = new Set();
      let explanationText = null;

      const addReason = (val) => {
        if (typeof val === "string" && val.trim().length > 8) {
          reasons.add(val.trim());
        } else if (val && typeof val === "object") {
          const t = val.text || val.title || val.reason || val.name;
          if (typeof t === "string" && t.trim().length > 8) {
            reasons.add(t.trim());
          }
        }
      };

      const addAdvertiser = (val) => {
        if (typeof val === "string" && val.trim().length > 1) {
          advertisers.add(val.trim());
        } else if (val && typeof val === "object") {
          const t = val.name || val.title || val.text;
          if (typeof t === "string" && t.trim().length > 1) {
            advertisers.add(t.trim());
          }
        }
      };

      const walk = (obj, depth = 0) => {
        if (!obj || typeof obj !== "object" || depth > 10) return;
        if (Array.isArray(obj)) {
          obj.forEach((item) => walk(item, depth + 1));
          return;
        }
        for (const key in obj) {
          const val = obj[key];
          if (
            (key === "waist_targeting_data" || key === "targeting_data") &&
            Array.isArray(val)
          ) {
            val.forEach(addReason);
          }
          if (
            (key === "ad_explanation" ||
              key === "explanation" ||
              key === "explanation_text") &&
            !explanationText
          ) {
            if (typeof val === "string" && val.trim()) {
              explanationText = val.trim();
            } else if (val && typeof val === "object") {
              const t = val.text || val.body || val.title;
              if (typeof t === "string" && t.trim()) {
                explanationText = t.trim();
              }
            }
          }
          if (key === "advertiser" || key === "advertisers") {
            if (Array.isArray(val)) val.forEach(addAdvertiser);
            else addAdvertiser(val);
          }
          if (val && typeof val === "object") walk(val, depth + 1);
        }
      };

      walk(data);

      return {
        explanation_text: explanationText || "",
        reasons: [...reasons],
        advertisers: [...advertisers],
        fetched_at: Date.now(),
        source: "graphql-direct",
        raw: responseText,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Sleep helper
   * @param {number} ms
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get stats
   * @returns {Object}
   */
  getStats() {
    return {
      cacheSize: this.explanationCache.size,
      activeRequests: this.activeRequests.size,
      queueSize: this.fetchQueue.length,
      rateLimitMs: this.rateLimitMs,
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.explanationCache.clear();
  }
}

// Instantiate globally
window.CMN_ExplanationFetcher = new ExplanationFetcher();
