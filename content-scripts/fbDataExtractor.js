// content-scripts/fbDataExtractor.js - UPDATED FOR CURRENT FACEBOOK DOM

class FBDataExtractor {
  constructor() {
    this.failedExtractions = 0;
  }

  // Extract all data from post
  extractPostData(element, postId) {
    try {
      // Only extract what you actually need!
      const postLink = element.querySelector('a[role="link"][href*="/posts/"]');

      if (!postLink) {
        return null;
      }

      const data = {
        // MATCHING IDENTIFIERS (essential)
        postId: postId,
        postUrl: postLink.href.split("?")[0],

        // TIMING (for verification)
        postTime: this.extractPostTime(element),
        timestamp: Date.now(),

        // DETECTION (minimal)
        isSponsored: this.detectSponsored(element),
        mediaType: this.detectMediaType(element),

        // Context
        pageUrl: window.location.href,
        pageTitle: document.title,
      };

      return data;
    } catch (error) {
      return null;
    }
  }

  // Helper: Minimal post time extraction
  extractPostTime(element) {
    const postLink = element.querySelector('a[role="link"][href*="/posts/"]');
    if (postLink?.textContent) {
      return postLink.textContent.trim(); // Return as-is: "2 hours ago"
    }
    return null;
  }

  // Helper: Minimal sponsored detection
  detectSponsored(element) {
    const text = element.textContent.toLowerCase();
    return text.includes("sponsored") || text.includes("ad");
  }

  // Helper: Minimal media detection
  detectMediaType(element) {
    if (element.querySelector("video")) return "video";
    if (element.querySelector('img[src*="scontent"]')) return "image";
    return "text";
  }

  // ✅ UPDATED: Extract post URL using new Facebook selectors
  extractPostUrl(element) {
    const selectors = [
      // ✅ NEW: Facebook uses role="link" with /posts/ in href
      'a[role="link"][href*="/posts/"]',
      'a[href*="/posts/"]',
      'a[href*="/photos/"]',
      'a[href*="/videos/"]',
      'a[role="link"][href*="facebook.com"]',
    ];

    for (const selector of selectors) {
      try {
        const link = element.querySelector(selector);
        if (link?.href) {
          // Extract clean URL without parameters
          const url = link.href.split("?")[0];
          return url;
        }
      } catch (e) {
        continue;
      }
    }

    return null;
  }

  // ✅ UPDATED: Extract post time using new Facebook selectors
  extractPostTime(element) {
    try {
      // Strategy 1: Get timestamp from post link text (e.g., "2 hours ago")
      const timestampLink = element.querySelector(
        'a[role="link"][href*="/posts/"]'
      );
      if (timestampLink) {
        const timeText = timestampLink.textContent.trim();
        const parsedTime = this.parseRelativeTime(timeText);
        if (parsedTime) {
          return parsedTime;
        }
      }

      // Strategy 2: Look for abbr with data-utime (older format)
      const abbr = element.querySelector("abbr[data-utime]");
      if (abbr) {
        const utime = abbr.getAttribute("data-utime");
        return parseInt(utime) * 1000;
      }

      // Strategy 3: Look for time element
      const timeEl = element.querySelector("time");
      if (timeEl) {
        const datetime = timeEl.getAttribute("datetime");
        if (datetime) {
          return new Date(datetime).getTime();
        }
      }
    } catch (e) {
    }

    return Date.now();
  }

  // ✅ NEW: Parse relative time like "2 hours ago"
  parseRelativeTime(timeStr) {
    if (!timeStr) return null;

    const now = Date.now();
    const lowerStr = timeStr.toLowerCase();

    // Match patterns like "2 hours ago", "1 day ago", etc.
    const match = timeStr.match(/(\d+)\s+(\w+)\s+ago/i);
    if (match) {
      const amount = parseInt(match[1]);
      const unit = match[2].toLowerCase();

      let milliseconds = 0;
      if (unit.includes("second")) milliseconds = amount * 1000;
      else if (unit.includes("minute")) milliseconds = amount * 60 * 1000;
      else if (unit.includes("hour")) milliseconds = amount * 60 * 60 * 1000;
      else if (unit.includes("day"))
        milliseconds = amount * 24 * 60 * 60 * 1000;
      else if (unit.includes("week"))
        milliseconds = amount * 7 * 24 * 60 * 60 * 1000;
      else if (unit.includes("month"))
        milliseconds = amount * 30 * 24 * 60 * 60 * 1000;
      else if (unit.includes("year"))
        milliseconds = amount * 365 * 24 * 60 * 60 * 1000;

      const result = now - milliseconds;
      return result;
    }

    // Handle "just now"
    if (lowerStr.includes("just now") || lowerStr.includes("now")) {
      return now;
    }

    return null;
  }

  // Extract author information
  extractAuthor(element) {
    const author = {
      name: null,
      profileUrl: null,
      profileId: null,
      pageType: null,
    };

    // Find author link - look for first role="link" that points to profile
    const links = element.querySelectorAll('a[role="link"]');
    for (const link of links) {
      const href = link.href;
      if (href.includes("facebook.com") && !href.includes("/posts/")) {
        author.name = link.textContent.trim();
        author.profileUrl = href;
        author.profileId = this.extractProfileId(href);

        // Detect if page or profile
        if (href.includes("/pages/")) {
          author.pageType = "page";
        } else {
          author.pageType = "profile";
        }
        break;
      }
    }

    return author;
  }

  // Extract profile ID from URL
  extractProfileId(url) {
    if (!url) return null;

    // Handle different URL formats
    const patterns = [
      /facebook\.com\/([^/?]+)/,
      /facebook\.com\/pages\/[^/]+\/(\d+)/,
      /facebook\.com\/profile\.php\?id=(\d+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  // Extract post content
  extractContent(element) {
    const contentSelectors = [
      '[data-ad-preview="message"]',
      '[data-ad-comet-preview="message"]',
      'div[dir="auto"]',
      ".userContent",
      '[data-testid="post_message"]',
    ];

    for (const selector of contentSelectors) {
      try {
        const contentEl = element.querySelector(selector);
        if (contentEl) {
          return this.cleanText(contentEl.textContent);
        }
      } catch (e) {
        continue;
      }
    }

    return "";
  }

  // Clean text
  cleanText(text) {
    return text
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, ""); // Remove zero-width characters
  }

  // Detect media type
  detectMediaType(element) {
    if (element.querySelector("video")) return "video";
    if (element.querySelector('img[src*="scontent"]')) return "image";
    if (element.querySelector('[data-testid="post_message"]')) return "text";
    return "unknown";
  }

  // Extract image URLs
  extractImageUrls(element) {
    const images = element.querySelectorAll('img[src*="scontent"]');
    const urls = [];

    images.forEach((img) => {
      if (img.src && !img.src.includes("emoji")) {
        urls.push(img.src);
      }
    });

    return urls;
  }

  // Extract video URL
  extractVideoUrl(element) {
    const video = element.querySelector("video");
    return video?.src || null;
  }

  // Extract external URL
  extractExternalUrl(element) {
    // Look for Facebook redirect links
    const externalLink = element.querySelector('a[href*="l.facebook.com"]');

    if (externalLink) {
      const url = externalLink.href;

      // Decode Facebook redirect URL
      try {
        const urlObj = new URL(url);
        const targetUrl = urlObj.searchParams.get("u");
        if (targetUrl) {
          return decodeURIComponent(targetUrl);
        }
      } catch (e) {
        // Fallback
      }

      return url;
    }

    // Look for direct external links
    const directLink = element.querySelector(
      'a[target="_blank"][rel*="nofollow"]'
    );
    return directLink?.href || null;
  }

  // Extract domain from URL
  extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace("www.", "");
    } catch (e) {
      return null;
    }
  }

  // Extract reactions count
  extractReactions(element) {
    const reactionSelectors = [
      '[aria-label*="reaction"]',
      '[aria-label*="Like"]',
      'span[aria-label*="people"]',
    ];

    for (const selector of reactionSelectors) {
      try {
        const el = element.querySelector(selector);
        if (el) {
          return this.parseNumber(
            el.getAttribute("aria-label") || el.textContent
          );
        }
      } catch (e) {
        continue;
      }
    }

    return 0;
  }

  // Extract comments count
  extractComments(element) {
    const commentSelectors = [
      '[aria-label*="comment"]',
      'a[href*="/comments/"]',
    ];

    for (const selector of commentSelectors) {
      try {
        const el = element.querySelector(selector);
        if (el) {
          return this.parseNumber(el.textContent);
        }
      } catch (e) {
        continue;
      }
    }

    return 0;
  }

  // ✅ FIXED: Extract shares count with valid selectors
  extractShares(element) {
    const shareSelectors = [
      '[aria-label*="share"]',
      'a[href*="share"]',
      'button[aria-label*="share"]',
      'div[data-testid*="share"]',
    ];

    for (const selector of shareSelectors) {
      try {
        const el = element.querySelector(selector);
        if (el) {
          return this.parseNumber(el.textContent);
        }
      } catch (e) {
        continue;
      }
    }

    return 0;
  }

  // Parse number from text (handles K, M notation)
  parseNumber(text) {
    if (!text) return 0;

    const match = text.match(/(\d+(?:\.\d+)?)\s*([KM])?/i);
    if (!match) return 0;

    let num = parseFloat(match[1]);
    const suffix = match[2];

    if (suffix) {
      if (suffix.toUpperCase() === "K") num *= 1000;
      if (suffix.toUpperCase() === "M") num *= 1000000;
    }

    return Math.round(num);
  }

  // Detect if sponsored
  detectSponsored(element) {
    const text = element.textContent.toLowerCase();
    const keywords = ["sponsored", "спонсируется", "sponsorisé", "patrocinado"];
    return keywords.some((k) => text.includes(k));
  }

  // Extract hashtags
  extractHashtags(element) {
    const hashtags = [];
    const links = element.querySelectorAll('a[href*="/hashtag/"]');

    links.forEach((link) => {
      const tag = link.textContent.trim();
      if (tag.startsWith("#")) {
        hashtags.push(tag);
      }
    });

    return hashtags;
  }

  // Extract mentions
  extractMentions(element) {
    const mentions = [];
    const links = element.querySelectorAll('a[data-hovercard*="user"]');

    links.forEach((link) => {
      const mention = link.textContent.trim();
      if (mention.startsWith("@") || link.href.includes("facebook.com")) {
        mentions.push({
          name: mention,
          url: link.href,
        });
      }
    });

    return mentions;
  }

  // Get extraction stats
  getStats() {
    return {
      failedExtractions: this.failedExtractions,
    };
  }

  // Detect ad type
  detectAdType(element) {
    const text = element.textContent.toLowerCase();

    if (text.includes("paid for by") || text.includes("political ad")) {
      return "political";
    }

    if (element.querySelector('a[href*="/ads/"]')) {
      return "sponsored";
    }

    if (text.includes("suggested for you")) {
      return "suggested";
    }

    return "boosted";
  }

  // Extract advertiser name
  extractAdvertiserName(element) {
    // Look for "Sponsored" or "Paid for by" text
    const sponsorText = element.querySelector('[aria-label*="Sponsored"]');
    if (sponsorText) {
      const text = sponsorText.textContent;
      // Parse "Sponsored by XYZ"
      const match = text.match(/(?:Sponsored|Paid for) by (.+)/i);
      if (match) return match[1].trim();
    }

    // Fallback to author name
    return this.extractAuthor(element).name;
  }

  // Extract call-to-action
  extractCTA(element) {
    const ctaButtons = element.querySelectorAll('a[role="button"], button');

    for (const button of ctaButtons) {
      const text = button.textContent.trim().toLowerCase();
      const ctaKeywords = [
        "learn more",
        "shop now",
        "sign up",
        "download",
        "get offer",
        "book now",
        "subscribe",
        "apply",
      ];

      if (ctaKeywords.some((keyword) => text.includes(keyword))) {
        return button.textContent.trim();
      }
    }

    return null;
  }

  // Extract ad transparency info
  extractAdInfo(element) {
    const adInfoLink = element.querySelector('a[href*="/ads/about"]');
    if (!adInfoLink) return null;

    return {
      adInfoUrl: adInfoLink.href,
      hasTransparency: true,
    };
  }
}

// Export
window.FBDataExtractor = FBDataExtractor;
