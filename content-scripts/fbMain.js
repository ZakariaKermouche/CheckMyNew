// content-scripts/fbMain.js - FULLY FIXED VERSION

(function () {
  if (!location.hostname.includes("facebook.com")) return;

  class CheckMyNewsMain {
    constructor() {
      // Components
      this.observer = null;
      this.postDetector = null;
      this.dataExtractor = null;
      this.newsFilter = null;
      this.storageManager = null;
      this.messageHandler = null;
      this.bootstrapBridge = null;
      this.visibilityTracker = null;
      this.adActivityTracker = null;

      // State
      this.monitoring = false;
      this.initialized = false;
      this.graphqlPostsMap = new Map();
      this.domPostsInProcess = new Map();
      this.pendingDomByFingerprint = new Map();
      this.docIdPrimeAttempts = new Set();

      // Config
      this.config = {
        enabled: true,
        debugMode: false,
        collectSponsored: true,
        autoStart: true,
        explanationsEnabled: false,
        silentExplanationFetch: false,
        collectAdActivity: false,
      };

      // Stats
      this.stats = {
        postsDetected: 0,
        newsPostsCollected: 0,
        adsCollected: 0,
        regularPostsIgnored: 0,
        errors: 0,
        graphqlPostsReceived: 0,
        postsFoundInDOM: 0,
        explanationsTriggered: 0,
      };

      this.fingerprintIndex = new Map(); // fingerprint -> Set of post_ids
      this.domElementByPostId = new Map(); // postId -> HTMLElement (best-effort)
    }

    normalizeStringForFingerprint(text) {
      if (!text) return "";
      return (
        text
          .toLowerCase()
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          // Strip Arabic diacritics and tatweel to improve matching.
          .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
          // Keep letters/numbers from all languages (e.g., Arabic), drop punctuation.
          .replace(/[^\p{L}\p{N}\s]/gu, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 48)
      );
    }

    buildFingerprint({ authorName, groupName, message }) {
      const normalizedMessage = this.normalizeStringForFingerprint(message);
      if (normalizedMessage) {
        return normalizedMessage;
      }
      const normalizedAuthor = this.normalizeStringForFingerprint(authorName);
      if (normalizedAuthor) {
        return `author:${normalizedAuthor}`;
      }
      const normalizedGroup = this.normalizeStringForFingerprint(groupName);
      if (normalizedGroup) {
        return `group:${normalizedGroup}`;
      }
      return null;
    }

    registerFingerprint(postData) {
      if (!postData) return;
      const fingerprint = this.buildFingerprint({
        authorName: postData.author?.name,
        groupName: postData.to?.name,
        message: postData.message,
      });
      if (!fingerprint) return;
      postData.matchFingerprint = fingerprint;
      const bucket = this.fingerprintIndex.get(fingerprint) || new Set();
      const key = postData.post_id || postData.id;
      if (key) {
        bucket.add(key);
        this.fingerprintIndex.set(fingerprint, bucket);
      }
    }

    matchGraphQLByFingerprint(fingerprint) {
      if (!fingerprint) return null;
      const bucket = this.fingerprintIndex.get(fingerprint);
      if (!bucket) return null;
      for (const postId of bucket) {
        const candidate = this.graphqlPostsMap.get(postId);
        if (candidate && !candidate.inDOM) {
          return candidate;
        }
      }
      return null;
    }

    matchGraphQLByMessagePrefix(domMetadata) {
      const domMessage = this.normalizeStringForFingerprint(
        domMetadata?.message
      );
      if (!domMessage) return null;

      const domAuthor = this.normalizeStringForFingerprint(
        domMetadata?.authorName
      );
      const domGroup = this.normalizeStringForFingerprint(
        domMetadata?.groupName
      );

      const domTokens = domMessage.split(" ").filter(Boolean);
      const domTokenPrefix =
        domTokens.length >= 3 ? domTokens.slice(0, 3).join(" ") : domMessage;

      for (const candidate of this.graphqlPostsMap.values()) {
        if (!candidate || candidate.inDOM) continue;
        const candidateMessage = this.normalizeStringForFingerprint(
          candidate.message
        );
        if (!candidateMessage) continue;

        if (
          !candidateMessage.startsWith(domMessage) &&
          !candidateMessage.startsWith(domTokenPrefix)
        ) {
          continue;
        }

        if (domAuthor) {
          const candAuthor = this.normalizeStringForFingerprint(
            candidate.author?.name
          );
          if (candAuthor && candAuthor !== domAuthor) continue;
        }

        if (domGroup) {
          const candGroup = this.normalizeStringForFingerprint(
            candidate.to?.name
          );
          if (candGroup && candGroup !== domGroup) continue;
        }

        return candidate;
      }

      return null;
    }

    extractDomMetadata(element) {
      return {
        postId: this.extractPostIdFromElement(element),
        authorName: this.extractProfileNameFromElement(element),
        groupName: this.extractGroupNameFromElement(element),
        message: this.extractPostMessageFromElement(element),
      };
    }

    extractPostIdFromElement(element) {
      try {
        if (!element) return null;

        // Direct attributes
        const direct =
          element.getAttribute("data-post-id") ||
          element.getAttribute("data-feed-item-id") ||
          element.getAttribute("data-story-id");
        if (direct && /^\d{6,}$/.test(direct)) return direct;

        // Look for any descendant carrying known ids
        const candidate = element.querySelector(
          "[data-post-id], [data-feed-item-id], [data-story-id]"
        );
        if (candidate) {
          const val =
            candidate.getAttribute("data-post-id") ||
            candidate.getAttribute("data-feed-item-id") ||
            candidate.getAttribute("data-story-id");
          if (val && /^\d{6,}$/.test(val)) return val;
        }

        // data-ft is often JSON with top_level_post_id / content_owner_id_new
        const dataFtEl = element.querySelector("[data-ft]") || element;
        const dataFt = dataFtEl?.getAttribute("data-ft");
        if (dataFt) {
          try {
            const parsed = JSON.parse(dataFt);
            const id =
              parsed?.top_level_post_id ||
              parsed?.top_level_post_id_for_top_level_comments ||
              null;
            if (id && /^\d{6,}$/.test(String(id))) return String(id);
          } catch (_) {
            // data-ft sometimes isn't strict JSON; fall back to regex
            const match = dataFt.match(/"top_level_post_id"\s*:\s*"(\d+)"/);
            if (match?.[1]) return match[1];
          }
        }

        // data-ftid can include a numeric post id
        const dataFtid = element.getAttribute("data-ftid");
        if (dataFtid) {
          const match = dataFtid.match(/(\d{6,})/);
          if (match?.[1]) return match[1];
        }

        // Try permalink-style anchors:
        // /{page}/posts/{id}, /groups/{gid}/posts/{id}, /permalink/{id}, story_fbid={id}
        const anchors = Array.from(element.querySelectorAll('a[href]'));
        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          if (!href) continue;
          const absolute = href.startsWith("http")
            ? href
            : `https://www.facebook.com${href.startsWith("/") ? href : `/${href}`}`;
          let url;
          try {
            url = new URL(absolute);
          } catch (_) {
            continue;
          }

          const qStory = url.searchParams.get("story_fbid");
          if (qStory && /^\d{6,}$/.test(qStory)) return qStory;
          const qFbid = url.searchParams.get("fbid");
          if (qFbid && /^\d{6,}$/.test(qFbid)) return qFbid;
          const qMulti = url.searchParams.get("multi_permalinks");
          if (qMulti) {
            const mMulti = qMulti.match(/(\d{6,})/);
            if (mMulti?.[1]) return mMulti[1];
          }

          const path = url.pathname || "";
          const m =
            path.match(/\/posts\/(\d{6,})/) ||
            path.match(/\/permalink\/(\d{6,})/) ||
            path.match(/\/videos\/(\d{6,})/);
          if (m?.[1]) return m[1];

          // Last resort: extract a large numeric token from full URL.
          const rawUrl = `${url.pathname}${url.search}`;
          const mAny = rawUrl.match(/(\d{10,})/);
          if (mAny?.[1]) return mAny[1];
        }
      } catch (_) {}

      return null;
    }

    extractProfileNameFromElement(element) {
      const profileEl = element.querySelector(
        '[data-ad-rendering-role="profile_name"]'
      );
      if (!profileEl) return null;

      const author =
        profileEl.parentElement?.parentElement.parentElement
          ?.nextElementSibling;

      return author?.textContent?.trim() || null;
    }

    extractGroupNameFromElement(element) {
      const groupEl = element.querySelector(
        'a[href*="/groups/"] span, [data-ad-rendering-role="story_to"] span'
      );
      return groupEl?.textContent?.trim() || null;
    }

    extractPostMessageFromElement(element) {
      const messageEl =
        element.querySelector(
          '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]'
        ) || element.querySelector('[data-testid="post_message"]');
      return messageEl?.textContent?.trim() || null;
    }

    // Extract profile URL from post element (author profile link)
    extractProfileUrlFromElement(element) {
      if (!element) return null;

      // Look for profile links in post header (common FB patterns)
      const profileLinks = element.querySelectorAll('a[href]');
      for (const link of profileLinks) {
        const href = link.getAttribute('href') || '';
        
        // Match profile, user page, or groups patterns
        if (
          href.includes('/profile.php?id=') ||
          href.match(/^\/[a-z0-9.]+(\?|$)/) || // /{username}
          href.includes('facebook.com/') ||
          href.match(/\/pages\/[\w-]+\//) // Pages
        ) {
          // Only take if it's likely a profile (check it's in header area)
          const rect = link.getBoundingClientRect();
          // Profile link should be near top of post
          if (rect.top >= element.getBoundingClientRect().top &&
              rect.top <= element.getBoundingClientRect().top + 150) {
            try {
              const fullUrl = href.startsWith('http') 
                ? href 
                : `https://www.facebook.com${href}`;
              return new URL(fullUrl).href;
            } catch (_) {
              continue;
            }
          }
        }
      }
      
      return null;
    }

    // Extract post permalink URL from post element
    extractPostUrlFromElement(element) {
      if (!element) return null;

      // Look for permalink anchors in the post
      const anchors = Array.from(element.querySelectorAll('a[href]'));
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (!href) continue;

        // Check if this looks like a post permalink
        const absolute = href.startsWith('http')
          ? href
          : `https://www.facebook.com${href.startsWith('/') ? href : `/${href}`}`;
        
        let url;
        try {
          url = new URL(absolute);
        } catch (_) {
          continue;
        }

        // Match patterns: /posts/{id}, /permalink/{id}, /videos/{id}, story_fbid={id}
        const path = url.pathname || '';
        const hasPermalinkPattern = 
          path.match(/\/posts\/\d+/) ||
          path.match(/\/permalink\/\d+/) ||
          path.match(/\/videos\/\d+/) ||
          path.match(/\/photos\/\d+/) ||
          url.searchParams.get('story_fbid');

        if (hasPermalinkPattern) {
          // Ensure it's a post-related link (not just any link in the post)
          const text = a.textContent || '';
          const ariaLabel = a.getAttribute('aria-label') || '';
          const role = a.getAttribute('role') || '';
          
          // Permalink links often have specific characteristics
          if (
            role === 'link' && (ariaLabel.includes('Full story') || ariaLabel.includes('See more') || ariaLabel.includes('Open')) ||
            text.match(/^\d{1,2}[hmd]\b/) || // Time indicators like "2h", "3m"
            a.closest('[data-testid="post_header"]') ||
            a.closest('[role="article"]')?.querySelector('[data-testid="post_message"]')?.contains(a) === false
          ) {
            return url.href;
          }
        }
      }

      // Fallback: construct URL from post ID if found
      const postId = this.extractPostIdFromElement(element);
      if (postId) {
        return `https://www.facebook.com/${postId}`;
      }

      return null;
    }

    // Extract Facebook ID from profile URL
    extractProfileIdFromUrl(url) {
      if (!url) return null;

      try {
        const urlObj = new URL(url);
        
        // Pattern 1: /profile.php?id=123
        const idParam = urlObj.searchParams.get('id');
        if (idParam && /^\d+$/.test(idParam)) {
          return idParam;
        }
        
        // Pattern 2: /pages/name/123
        const pathMatch = urlObj.pathname.match(/\/pages\/[\w-]+\/(\d+)/);
        if (pathMatch?.[1]) {
          return pathMatch[1];
        }
        
        // Pattern 3: Standard pattern fbid
        const fbidMatch = urlObj.searchParams.get('fbid');
        if (fbidMatch && /^\d+$/.test(fbidMatch)) {
          return fbidMatch;
        }
      } catch (_) {
        // Fall back to regex
        const regexMatch = url.match(/(?:id|fbid)=(\d+)/);
        if (regexMatch?.[1]) {
          return regexMatch[1];
        }
      }
      
      return null;
    }

    // Extract profile picture from post element
    extractProfilePictureFromElement(element) {
      if (!element) return null;

      // Look for avatar images (typically in post header)
      // Facebook uses img with specific patterns for profile pictures
      const imgs = element.querySelectorAll('img[src]');
      for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        const alt = img.getAttribute('alt') || '';
        
        // Profile pictures often have certain src patterns
        if (
          src.includes('scontent') && src.includes('profile') ||
          src.match(/\/t[\d.]+x[\d.]+\//) || // Thumbnail pattern
          alt.match(/^[A-Z]/) // Alt text starts with capital (likely name)
        ) {
          const rect = img.getBoundingClientRect();
          // Avatar should be near top and small
          if (rect.width < 100 && rect.height < 100 &&
              rect.top >= element.getBoundingClientRect().top &&
              rect.top <= element.getBoundingClientRect().top + 150) {
            return src;
          }
        }
      }

      // Fallback: look for images with role="img"
      const roleImg = element.querySelector('img[role="img"]');
      if (roleImg) {
        const src = roleImg.getAttribute('src');
        if (src) return src;
      }

      return null;
    }

    generateAdAnalystId() {
      const randomDigits = Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0");
      const perfDigits = Math.floor(
        typeof performance !== "undefined" ? performance.now() : 0
      )
        .toString()
        .padStart(6, "0");
      return `${Date.now()}${perfDigits}${randomDigits}`;
    }

    extractLandingPagesFromElement(element) {
      if (!element) return [];
      const anchors = Array.from(element.querySelectorAll("a[href]"));
      const out = [];
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        if (!href) continue;

        let url = href;
        try {
          const parsed = new URL(href, window.location.origin);
          if (parsed.hostname.includes("l.facebook.com")) {
            const u = parsed.searchParams.get("u");
            if (u) url = u;
          } else {
            url = parsed.href;
          }
        } catch {
          // keep raw href
        }

        if (typeof url === "string") {
          out.push(url.split("#")[0]);
        }
      }
      return [...new Set(out.filter(Boolean))];
    }

    extractImagesFromElement(element) {
      if (!element) return [];
      const images = [];
      const imgEls = Array.from(element.querySelectorAll("img[src]"));
      for (const img of imgEls) {
        const src = img.getAttribute("src");
        if (src) images.push(src);
      }

      const styled = Array.from(element.querySelectorAll("[style]"));
      for (const el of styled) {
        const style = el.getAttribute("style") || "";
        const match = style.match(
          /background-image:\s*url\((['\"]?)(.*?)\1\)/i
        );
        if (match && match[2]) images.push(match[2]);
      }

      return [...new Set(images.filter(Boolean))];
    }

    extractAdvertiserInfoFromElement(_element, postData) {
      const advertiser = {
        advertiser_facebook_id: null,
        advertiser_facebook_page: null,
        advertiser_facebook_profile_pic: null,
      };

      if (postData?.author?.page) {
        try {
          advertiser.advertiser_facebook_page = new URL(
            postData.author.page,
            window.location.origin
          ).href;
        } catch {
          advertiser.advertiser_facebook_page = postData.author.page;
        }
      }
      if (postData?.author?.id) {
        advertiser.advertiser_facebook_id = String(postData.author.id);
      }
      if (postData?.author?.profile_picture) {
        advertiser.advertiser_facebook_profile_pic =
          postData.author.profile_picture;
      }

      return advertiser;
    }

    extractLandingPagesFromPostData(postData) {
      if (!postData?.ad?.ad_id) return [];
      const urls = new Set();

      if (postData?.ad?.url) urls.add(postData.ad.url);

      const attachments = Array.isArray(postData?.attachments)
        ? postData.attachments
        : [];
      for (const att of attachments) {
        if (att?.destination_url) urls.add(att.destination_url);
        if (Array.isArray(att?.action_links)) {
          att.action_links.forEach((u) => u && urls.add(u));
        }
      }

      return [...urls].filter(Boolean);
    }

    extractGraphqlImages(postData) {
      const urls = new Set();

      const graphqlImages = Array.isArray(postData?.images)
        ? postData.images
        : [];
      for (const img of graphqlImages) {
        if (img?.photo_image) urls.add(img.photo_image);
        if (img?.url) urls.add(img.url);
      }

      return [...urls].filter(Boolean);
    }

    // Extract images from attachments in a format matching the expected raw_ad structure
    extractAttachmentsFromPostData(postData) {
      const attachments = [];
      const sourceAttachments = Array.isArray(postData?.attachments)
        ? postData.attachments
        : [];
      
      for (const att of sourceAttachments) {
        if (!att) continue;
        
        const attachment = {
          type: att.type || "Photo",
          id: att.id || null,
          image: {
            flexible: att.image?.flexible || null,
            large: att.image?.large || null,
            width: att.image?.width || null,
            height: att.image?.height || null,
          },
          title: att.title || null,
          destination_url: att.destination_url || null,
          fbclid: att.fbclid || null,
          action_links: Array.isArray(att.action_links) ? att.action_links : [],
        };
        attachments.push(attachment);
      }
      
      return attachments;
    }

    extractGraphqlVideos(postData) {
      const out = [];
      const graphqlVideos = Array.isArray(postData?.videos)
        ? postData.videos
        : [];
      for (const vid of graphqlVideos) {
        if (!vid) continue;
        out.push({
          videoId: vid.videoId || vid.id || null,
          thumbnailImage: vid.thumbnailImage || null,
          url: vid.url || null,
        });
      }
      return out;
    }

    extractAttachmentMediaUrls(postData) {
      const urls = new Set();
      const attachments = Array.isArray(postData?.attachments)
        ? postData.attachments
        : [];
      for (const att of attachments) {
        if (att?.image?.flexible) urls.add(att.image.flexible);
        if (att?.image?.large) urls.add(att.image.large);
      }
      return [...urls].filter(Boolean);
    }

    extractVideoInfo(postData) {
      const graphqlVideo =
        (Array.isArray(postData?.videos) && postData.videos.find((v) => v)) ||
        null;
      if (graphqlVideo) {
        return {
          video: true,
          video_id: graphqlVideo.videoId || graphqlVideo.id || "",
        };
      }
      return {
        video: false,
        video_id: "",
      };
    }

    isPublicPostElement(element) {
      if (!element) return false;
      const svgs = element.querySelectorAll("svg");
      for (const svg of svgs) {
        const w = parseInt(svg.getAttribute("width") || "0", 10);
        const h = parseInt(svg.getAttribute("height") || "0", 10);
        if (w > 20 || h > 20) continue;
        if (svg.closest("a")) continue;
        const paths = svg.querySelectorAll("path");
        if (paths.length >= 3) {
          return true;
        }
      }
      return false;
    }

    buildRegisterAdPayload(postData) {
      if (!postData) return null;
      const postId = postData.post_id || postData.id;

      const isSponsored = Boolean(
        postData.ad?.ad_id || postData.isSponsored || postData.sponsored
      );

      const isNewsPost = this.newsFilter?.isNewsPost
        ? this.newsFilter.isNewsPost(postData)
        : false;

      const isPublicPost =
        !isSponsored && !isNewsPost && !this.isPrivatePost(postData);

      if (!isSponsored && !isNewsPost && !isPublicPost) return null;

      const postType = isSponsored
        ? "frontAd"
        : isNewsPost
        ? "newsPost"
        : "publicPost";
      const graphQlAdId = postData?.ad?.ad_id
        ? String(postData.ad.ad_id)
        : null;
      const postIdentifier = postData.post_id || postData.id || null;
      const normalizedPostIdentifier =
        typeof postIdentifier === "string" && /^\d{6,}$/.test(postIdentifier)
          ? postIdentifier
          : null;
      const stableBackendId = graphQlAdId || normalizedPostIdentifier;
      if (!stableBackendId) {
        return null;
      }
      const htmlId = String(stableBackendId);

      const visibleFraction =
        typeof postData?.visible_fraction === "number"
          ? postData.visible_fraction
          : 1;

      const landingPages = this.extractLandingPagesFromPostData(postData);
      const images = this.extractGraphqlImages(postData);
      const videos = this.extractGraphqlVideos(postData);
      const { video, video_id } = this.extractVideoInfo(postData);
      const attachment_media_urls = this.extractAttachmentMediaUrls(postData);

      const advertiser = this.extractAdvertiserInfoFromElement(null, postData);

      // Extract attachments in the proper format for raw_ad
      const formattedAttachments = this.extractAttachmentsFromPostData(postData);

      const maxRawAdLength = 30000;
      const rawAdGraphQL =
        typeof postData?.raw_ad === "string"
          ? postData.raw_ad
          : typeof postData?.rawAd === "string"
          ? postData.rawAd
          : JSON.stringify({
              post_id: postData.post_id || null,
              id: postData.id || null,
              message: postData.message || "",
              url: postData.url || "",
              author: postData.author || null,
              attachments: formattedAttachments,
              ad: postData.ad || null,
            });
      const safeRawAd =
        rawAdGraphQL.length > maxRawAdLength
          ? rawAdGraphQL.slice(0, maxRawAdLength)
          : rawAdGraphQL;

      const payload = {
        raw_ad: safeRawAd,
        html_ad_id: htmlId,
        fb_id: String(normalizedPostIdentifier || graphQlAdId || htmlId),
        objId: isSponsored ? postData.id || null : null,
        visible: true,
        visible_fraction: visibleFraction,
        visibleDuration: Array.isArray(postData.visibleDuration)
          ? postData.visibleDuration
          : [],
        timestamp: Date.now(),
        offsetX: typeof postData?.offsetX === "number" ? postData.offsetX : 0,
        offsetY: typeof postData?.offsetY === "number" ? postData.offsetY : 0,
        type: postType,
        images,
        videos,
        attachment_media_urls,
        user_id: null,
        clientToken:
          postData.ad_client_token || postData.ad?.client_token || null,
        explanationUrl: postData.explanation_url || null,
        graphQLAsyncParams: postData.graphQLAsyncParams || null,
        serialized_frtp_identifiers:
          postData.serialized_frtp_identifiers || null,
        story_debug_info: postData.story_debug_info || null,
        advertiser_facebook_id: advertiser.advertiser_facebook_id,
        advertiser_facebook_page: advertiser.advertiser_facebook_page,
        advertiser_facebook_profile_pic:
          advertiser.advertiser_facebook_profile_pic,
        video,
        video_id,
      };

      if (isSponsored && landingPages.length > 0) {
        payload.landing_pages = landingPages;
      } else {
        payload.landing_pages = [];
      }

      if (isNewsPost) {
        const landingDomain =
          postData.externalDomain ||
          (() => {
            try {
              const first = landingPages[0];
              return first ? new URL(first).hostname : "";
            } catch {
              return "";
            }
          })();
        payload.landing_domain = landingDomain;
        payload.adanalyst_ad_id = htmlId;
      }

      if (!isNewsPost) {
        payload.adanalyst_ad_id = htmlId;
      }

      return payload;
    }

    hashString(input) {
      let hash = 0;
      for (let i = 0; i < input.length; i++) {
        const chr = input.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0;
      }
      return Math.abs(hash).toString(36);
    }

    preparePostForQueue(postData) {
      const sanitized = { ...postData };
      sanitized.isSponsored = Boolean(
        sanitized.ad?.ad_id || sanitized.isSponsored || sanitized.sponsored
      );
      sanitized.messagePreview =
        postData.message?.slice(0, 120) || sanitized.messagePreview || null;
      sanitized.messageHash = this.hashString(postData.message || "");
      delete sanitized.author;
      delete sanitized.to;
      return sanitized;
    }

    isPrivatePost(postData) {
      const description =
        postData?.privacy?.description || postData?.privacy_description || "";
      return description.toLowerCase().includes("private");
    }

    queuePostForSending(postData) {
      if (!postData) return false;
      if (postData.queued) return false;
      if (this.isPrivatePost(postData)) return false;

      postData.queued = true;
      if (!postData.register_ad_payload) {
        postData.register_ad_payload = this.buildRegisterAdPayload(postData);
        if (!postData.register_ad_payload) {
          postData.queued = false;
          return false;
        }
      }
      const prepared = this.preparePostForQueue(postData);

      console.log("[CMN] 📤 POST QUEUED FOR SENDING:", {
        postId: prepared.post_id || prepared.id,
        source: prepared.source,
        isSponsored: prepared.isSponsored,
        adId: prepared.ad?.ad_id || null,
        messageLength: prepared.message?.length || 0,
        visibleDuration: prepared.visibleDuration,
        queueSize: this.storageManager.queue.length,
      });

      this.storageManager.addPost(prepared);
      return true;
    }

    log(...args) {
      if (this.config.debugMode || localStorage.getItem("CMN_DEBUG") === "1") {
      }
    }

    async init() {
      if (this.initialized) return;

      try {
        // Load config
        await this.loadConfig();

        if (!this.config.enabled) {
          return;
        }

        // Initialize all components
        this.messageHandler = new FBMessageHandler();
        this.postDetector = new FBPostDetector();
        this.dataExtractor = new FBDataExtractor();
        this.newsFilter = new FBNewsFilter();
        this.storageManager = new FBStorageManager();
        this.storageManager.init();
        this.visibilityTracker = new FBVisibilityTracker((visiblePostIds) =>
          this.handlePostsVisible(visiblePostIds)
        );

        this.bootstrapBridge = new FBBootstrapBridge((post) => {
          const author =
            post.author && typeof post.author === "object"
              ? post.author
              : post.author
              ? { name: post.author }
              : null;
          const to =
            post.to && typeof post.to === "object"
              ? post.to
              : post.to
              ? { name: post.to }
              : null;
          const postData = {
            ...post,
            author,
            to,
            source: "bootstrap",
            inDOM: false,
            domFoundAt: null,
            ad_client_token:
              post?.ad?.client_token || post?.ad_client_token || null,
          };
          if (typeof postData.isSponsored !== "boolean") {
            postData.isSponsored = Boolean(postData.ad?.ad_id);
          }

          const bootstrapId = post?.post_id || post?.id || null;
          if (bootstrapId) {
            this.log("Bootstrap post mapped", bootstrapId);
            this.graphqlPostsMap.set(bootstrapId, postData);
            this.registerFingerprint(postData);
            this.applyPendingDomMatch(postData);
          }
        });

        this.bootstrapBridge.start();

        // Initialize observer with callbacks
        this.observer = new FBObserver(
          (post) => this.handleDOMPost(post),
          (post) => this.handlePostRemoved(post)
        );

        // Setup GraphQL bridge
        this.setupGraphQLBridge();

        // Setup event handlers
        this.setupEventHandlers();

        // Start monitoring
        if (this.config.autoStart) {
          this.start();
        }

        this.initialized = true;
      } catch (error) {
        this.stats.errors++;
      }
    }

    // ✅ Setup bridge to receive posts from injected GraphQL script
    setupGraphQLBridge() {
      window.addEventListener("CMN_POSTS_EXTRACTED", (event) => {
        const posts = Array.isArray(event?.detail?.posts)
          ? event.detail.posts
          : [];
        if (posts.length === 0) return;
        posts.forEach((post) => {
          this.handleGraphQLPost(post);
        });
      });

      window.addEventListener("message", (event) => {
        const data = event.data || {};
        if (data.source !== "CMN_PAGE") {
          return;
        }
        // If this is a subframe, relay GraphQL payloads up to top frame so
        // the main pipeline (visibility/matching/queue) can consume one stream.
        if (
          window.top !== window &&
          data.type === "CMN_GRAPHQL_POSTS" &&
          data.relayedTop !== true
        ) {
          try {
            window.top.postMessage({ ...data, relayedTop: true }, "*");
          } catch (_) {}
        }
        if (data.type === "CMN_GRAPHQL_READY") {
          return;
        }

        if (data.type !== "CMN_GRAPHQL_POSTS") return;

        const posts = Array.isArray(data.posts) ? data.posts : [];
        if (posts.length === 0) return;
        posts.forEach((post) => {
          this.handleGraphQLPost(post);
        });
      });
    }

    // ✅ FIXED: Handle GraphQL posts with proper deduplication
    handleGraphQLPost(post) {
      try {
        this.stats.graphqlPostsReceived++;
        const postId = post.post_id || null;
        if (!postId) {
          console.log("[CMN] ⚠️  GraphQL post skipped: missing stable post_id", {
            id: post.id || null,
            message: post.message?.slice(0, 50) || "no message",
          });
          return;
        }

        console.log("[CMN] 📥 GraphQL Post Received:", {
          postId,
          isSponsored: !!post.ad?.ad_id,
          message: post.message?.slice(0, 50) || "no message",
          author: post.author?.name || "unknown",
          timestamp: Date.now(),
        });

        if (this.postDetector.isProcessedGraphQL(postId)) {
          console.log("[CMN] ⚠️  Post already processed:", postId);
          return;
        }

        this.postDetector.markAsProcessedGraphQL(postId);

        const author =
          post.author && typeof post.author === "object"
            ? post.author
            : post.author
            ? { name: post.author }
            : null;
        const to =
          post.to && typeof post.to === "object"
            ? post.to
            : post.to
            ? { name: post.to }
            : null;

        const postData = {
          id: post.id || postId,
          post_id: postId,
          author,
          to,
          message: post.message,
          url: post.url,
          creation_time: post.creation_time,
          privacy: post.privacy || post.privacy_description || null,
          feedback_id: post.feedback_id || null,
          attachments: Array.isArray(post.attachments) ? post.attachments : [],
          attachment_count:
            typeof post.attachment_count === "number"
              ? post.attachment_count
              : Array.isArray(post.attachments)
              ? post.attachments.length
              : 0,
          engagment: post.engagment || {
            reaction_count: null,
            comment_count: null,
            share_count: null,
          },
          ad: post.ad || null,
          isSponsored: Boolean(post.ad?.ad_id),
          externalDomain: this.extractDomain(post.url),
          detectedAt: Date.now(),
          source: "graphql",
          inDOM: false,
          domFoundAt: null,
          visibleAt: null,
          explanationTriggeredAt: null,
          whyAmISeeingThisData: null,
          seenAt: null,
          ad_explanation: post.ad_explanation || null,
          ad_targeting_reasons: Array.isArray(post.ad_targeting_reasons)
            ? post.ad_targeting_reasons
            : null,
          ad_advertisers: Array.isArray(post.advertisers)
            ? post.advertisers
            : null,
          ad_client_token:
            post.ad?.client_token || post.ad_client_token || null,
        };

        this.graphqlPostsMap.set(postData.post_id, postData);
        this.log("GraphQL post tracked", postData.post_id);
        this.stats.newsPostsCollected++;
      } catch (error) {
        this.stats.errors++;
        console.error("[CMN] ❌ Error in handleGraphQLPost:", error);
      }
    }

    // ✅ FIXED: Handle DOM posts with safe error handling
    // In handleDOMPost():
    handleDOMPost(postElement) {
      try {
        this.stats.postsDetected++;

        if (this.postDetector.isProcessed(postElement)) return;

        const domMetadata = this.extractDomMetadata(postElement);
        const domFingerprint = this.buildFingerprint(domMetadata);
        const domPostId = domMetadata.postId;

        if (!domFingerprint && !domPostId) return;

        this.log("DOM fingerprint detected", domFingerprint);

        // Build author object with enriched profile data
        let authorData = null;
        if (domMetadata.authorName) {
          authorData = { name: domMetadata.authorName };
          // Try to extract profile URL and ID from DOM
          const profileUrl = this.extractProfileUrlFromElement(postElement);
          if (profileUrl) {
            authorData.page = profileUrl;
            const profileId = this.extractProfileIdFromUrl(profileUrl);
            if (profileId) {
              authorData.id = profileId;
            }
          }
          // Try to extract profile picture
          const profilePic = this.extractProfilePictureFromElement(postElement);
          if (profilePic) {
            authorData.profile_picture = profilePic;
          }
        }

        const postData = {
          author: authorData,
          message: domMetadata.message,
          to: domMetadata.groupName ? { name: domMetadata.groupName } : null,
          source: "dom",
          detectedAt: Date.now(),
        };

        let gqlPost = null;
        let matchedPostId = null;

        if (domPostId && this.graphqlPostsMap.has(domPostId)) {
          gqlPost = this.graphqlPostsMap.get(domPostId);
          matchedPostId = domPostId;
        } else {
          gqlPost = this.matchGraphQLByFingerprint(domFingerprint);
          matchedPostId = gqlPost?.post_id || gqlPost?.id || null;

          if (!gqlPost) {
            gqlPost = this.matchGraphQLByMessagePrefix(domMetadata);
            matchedPostId = gqlPost?.post_id || gqlPost?.id || null;
          }
        }

        if (gqlPost && matchedPostId) {
          this.log("DOM matched GraphQL by fingerprint", matchedPostId);
          gqlPost.inDOM = true;
          gqlPost.domFoundAt = Date.now();
          gqlPost.matchFingerprint = domFingerprint;
          this.domElementByPostId.set(matchedPostId, postElement);
          if (!gqlPost.message && domMetadata.message) {
            gqlPost.message = domMetadata.message;
          }
          if (!gqlPost.author?.name && domMetadata.authorName) {
            gqlPost.author = { name: domMetadata.authorName };
          }
          if (!gqlPost.to?.name && domMetadata.groupName) {
            gqlPost.to = { name: domMetadata.groupName };
          }

          this.storageManager.updatePost(gqlPost.id, {
            inDOM: true,
            domFoundAt: gqlPost.domFoundAt,
          });

          if (this.visibilityTracker) {
            this.visibilityTracker.track(postElement, matchedPostId);
          }
        } else {
          // Skip DOM-only posts without GraphQL match - we only want posts with complete data
          this.log("Skipping DOM post without GraphQL match (incomplete data)", domPostId);
        }

        this.postDetector.markAsProcessed(postElement);
      } catch (error) {
        this.stats.errors++;
      }
    }

    applyPendingDomMatch(postData) {
      const fingerprint =
        postData.matchFingerprint ||
        this.buildFingerprint({
          authorName: postData.author?.name,
          groupName: postData.to?.name,
          message: postData.message,
        });
      if (!fingerprint) return;

      const pending = this.pendingDomByFingerprint.get(fingerprint);
      if (!pending) return;

      this.pendingDomByFingerprint.delete(fingerprint);
      postData.inDOM = true;
      postData.domFoundAt = pending.domFoundAt;
      if (!postData.message && pending.domMetadata?.message) {
        postData.message = pending.domMetadata.message;
      }
      if (!postData.author?.name && pending.domMetadata?.authorName) {
        postData.author = { name: pending.domMetadata.authorName };
      }
      if (!postData.to?.name && pending.domMetadata?.groupName) {
        postData.to = { name: pending.domMetadata.groupName };
      }

      this.storageManager.updatePost(postData.id, {
        inDOM: true,
        domFoundAt: postData.domFoundAt,
      });

      if (this.visibilityTracker) {
        const realId = postData.post_id || postData.id;
        this.visibilityTracker.track(pending.element, realId);
        this.domElementByPostId.set(realId, pending.element);
      }
    }

    // Handle when posts become visible
    handlePostsVisible(visiblePostIds) {
      visiblePostIds.forEach((postId) => {
        const postData = this.graphqlPostsMap.get(postId);

        if (!postData) {
          console.log("[CMN] ⚠️  Visible post not in map:", postId);
          return;
        }

        if (!postData.visibleAt) {
          // This is the FIRST time we're seeing it as visible
          const now = Math.floor(Date.now() / 1000) * 1000;
          postData.visibleAt = now;
          postData.seenAt = now;

          console.log("[CMN] ✅ POST MARKED AS SEEN:", {
            postId,
            message: postData.message?.slice(0, 50),
            isSponsored: postData.isSponsored,
          });

          if (!Array.isArray(postData.visibleDuration)) {
            postData.visibleDuration = [];
          }
          if (postData.visibleDuration.length === 0) {
            postData.visibleDuration.push({
              started_ts: now,
              end_ts: null,
            });
          }

          this.storageManager.updatePost(postData.id, {
            visibleAt: postData.visibleAt,
            seenAt: postData.seenAt,
            visibleDuration: postData.visibleDuration,
          });

          if (postData.isSponsored && postData.ad?.ad_id) {
            const element = this.domElementByPostId.get(postId) || null;
            let visibleFraction = null;
            if (element && this.visibilityTracker?.getVisibleState) {
              const state = this.visibilityTracker.getVisibleState(element);
              if (state?.totalHeight) {
                visibleFraction = state.visibleHeight / state.totalHeight;
              }
            }
            const dbId = postData.dbId || null;
            if (dbId) {
              try {
                chrome.runtime
                  .sendMessage({
                    type: "adVisibility",
                    dbId,
                    adId: postData.ad.ad_id,
                    postId,
                    started_ts: postData.visibleAt,
                    end_ts: null,
                    visible_fraction: visibleFraction,
                  })
                  .catch(() => {});
              } catch (_) {}
            }
          }

          if (postData.isSponsored) {
            this.triggerExplanationFetch(postData);
          }

          this.queuePostForSending(postData);
        }
      });
    }

    // Trigger explanation fetch
    triggerExplanationFetch(postData) {
      if (!this.config.explanationsEnabled) {
        return;
      }
      if (postData.explanationTriggeredAt) {
        return;
      }

      postData.explanationTriggeredAt = Date.now();
      this.stats.explanationsTriggered++;

      const postId = postData.post_id || postData.id;
      const adId = postData?.ad?.ad_id;

      if (!adId) {
        return;
      }

      if (this.config.silentExplanationFetch) {
        const fetcher = window.CMN_ExplanationFetcher;
        if (!fetcher?.fetchExplanationViaGraphQLRequest) {
          return;
        }

        const clientToken =
          postData.ad_client_token || postData.ad?.client_token || null;

        if (!clientToken) {
          return;
        }

        const handleSilentExplanation = (explanation, meta = {}) => {
          if (!explanation) {
            return;
          }

          chrome.runtime.sendMessage(
            {
              type: "registerExplanationData",
              payload: {
                ad_id: adId,
                explanation_text: explanation.explanation_text || "",
                explanation_reasons: explanation.reasons || [],
                advertisers: explanation.advertisers || [],
                links: [],
                explanation_url: null,
                meta: {
                  post_id: postData.post_id || null,
                  source: postData.source,
                  visibleAt: postData.visibleAt || null,
                  silent: true,
                  graphql_raw: explanation.raw || null,
                  ...meta,
                },
              },
            },
            (resp) => {
              if (chrome?.runtime?.lastError) {
                return;
              }
              if (!resp?.ok) {
                return;
              }
              this.log("Explanation registered silently", { postId, adId });
              this.storageManager.updatePost(postData.id, {
                explanationTriggeredAt: postData.explanationTriggeredAt,
              });
            }
          );
        };

        fetcher
          .fetchExplanationViaGraphQLRequest(adId, clientToken)
          .then((explanation) => handleSilentExplanation(explanation))
          .catch(async (e) => {
            const message = e?.message || String(e || "");

            if (!message.includes("doc_id_not_found")) return;

            const element = this.domElementByPostId.get(postId) || null;
            if (!element) {
              return;
            }

            if (this.docIdPrimeAttempts.has(adId)) {
              return;
            }
            this.docIdPrimeAttempts.add(adId);

            if (!fetcher?.primeDocIdSilently) {
              return;
            }

            const primed = await fetcher.primeDocIdSilently(element, {
              postId,
              adId,
            });

            if (!primed) {
              return;
            }

            try {
              const explanation =
                await fetcher.fetchExplanationViaGraphQLRequest(
                  adId,
                  clientToken
                );
              handleSilentExplanation(explanation, { primed: true });
            } catch (retryErr) {}
          });

        return;
      }

      const element = this.domElementByPostId.get(postId) || null;
      if (!element) {
        return;
      }

      const fetcher = window.CMN_ExplanationFetcher;
      if (!fetcher?.getExplanationUrlFromPostElement) {
        return;
      }

      fetcher
        .getExplanationUrlFromPostElement(element, { postId })
        .then((explanationUrl) => {
          if (!explanationUrl) {
            return;
          }

          chrome.runtime.sendMessage(
            {
              type: "queueExplanation",
              url: explanationUrl,
              adId,
              processNow: true,
              meta: {
                post_id: postData.post_id || null,
                source: postData.source,
                visibleAt: postData.visibleAt || null,
              },
            },
            (resp) => {
              if (chrome?.runtime?.lastError) {
                return;
              }
              if (!resp?.ok) {
                return;
              }

              this.log("Explanation queued", { postId, adId });
              this.storageManager.updatePost(postData.id, {
                explanationTriggeredAt: postData.explanationTriggeredAt,
                explanation_url: explanationUrl,
              });
            }
          );
        })
        .catch((e) => {});
    }

    // Check if element is already fully visible
    isElementFullyVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const viewHeight =
        window.innerHeight || document.documentElement.clientHeight;
      return (
        rect.top >= 0 &&
        rect.bottom <= viewHeight &&
        rect.left >= 0 &&
        rect.right <=
          (window.innerWidth || document.documentElement.clientWidth)
      );
    }

    // Extract domain from URL
    extractDomain(url) {
      if (!url) return null;
      try {
        // Handle various URL formats
        let domain = null;

        // Try to extract from external URL
        if (url.includes("facebook.com/")) {
          // It's a Facebook URL, extract from /posts/ or /photos/
          return null;
        }

        // It's an external URL
        const urlObj = new URL(url);
        domain = urlObj.hostname.replace("www.", "");

        return domain;
      } catch (e) {
        return null;
      }
    }

    setupEventHandlers() {
      this.messageHandler.on("stats-requested", ({ sendResponse }) => {
        sendResponse(this.getStats());
      });

      this.messageHandler.on("start-monitoring", () => {
        this.start();
      });

      this.messageHandler.on("stop-monitoring", () => {
        this.stop();
      });

      this.messageHandler.on("clear-queue", () => {
        this.storageManager.clearQueue();
      });

      this.messageHandler.on("config-updated", ({ config, sendResponse }) => {
        this.updateConfig(config);
        sendResponse({ success: true });
      });

      // Visibility tracker emits start/end windows; use the end event for ad visibility telemetry.
      window.addEventListener("CMN_POST_VISIBILITY", (evt) => {
        const detail = evt?.detail || {};
        const postId = detail.postId;
        if (!postId) return;

        const postData = this.graphqlPostsMap.get(postId);
        if (!postData) return;

        const startedTs = detail.started_ts || postData.visibleAt || null;
        const endTs = detail.end_ts || null;
        if (!startedTs || !endTs) return;

        if (!Array.isArray(postData.visibleDuration)) {
          postData.visibleDuration = [];
        }
        const last =
          postData.visibleDuration[postData.visibleDuration.length - 1];
        if (last && last.end_ts === null && last.started_ts === startedTs) {
          last.end_ts = endTs;
        } else {
          postData.visibleDuration.push({
            started_ts: startedTs,
            end_ts: endTs,
          });
        }

        this.storageManager.updatePost(postData.id || postData.post_id, {
          visibleDuration: postData.visibleDuration,
        });

        if (!postData.isSponsored) return;
        const dbId = postData.dbId || null;
        if (!dbId) return;

        try {
          chrome.runtime
            .sendMessage({
              type: "adVisibility",
              dbId,
              postId,
              started_ts: startedTs,
              end_ts: endTs,
            })
            .catch(() => {});
        } catch (_) {}
      });
    }

    start() {
      if (this.monitoring) return;
      this.monitoring = true;
      if (this.visibilityTracker) {
        this.visibilityTracker.start();
      }
      this.observer.start();
    }

    stop() {
      if (!this.monitoring) return;
      this.monitoring = false;
      this.observer.stop();
      if (this.visibilityTracker) {
        this.visibilityTracker.stop();
      }
    }

    handlePostRemoved(post) {
      if (this.config.debugMode) {
      }
    }

    async loadConfig() {
      try {
        const result = await chrome.storage.local.get(["cmn_config"]);
        if (result.cmn_config) {
          this.config = { ...this.config, ...result.cmn_config };
        }
      } catch (error) {}
    }

    async updateConfig(newConfig) {
      this.config = { ...this.config, ...newConfig };

      try {
        await chrome.storage.local.set({ cmn_config: this.config });
      } catch (error) {}
    }

    getStats() {
      const stats = {
        ...this.stats,
        isMonitoring: this.monitoring,
        isInitialized: this.initialized,
        queueStats: this.storageManager?.getStats() || {},
        observerStats: this.observer?.getStatus?.() || {},
        detectorStats: this.postDetector?.getStats() || {},
        extractorStats: this.dataExtractor?.getStats() || {},
        graphqlPostsTracked: this.graphqlPostsMap.size,
        domPostsInProcess: this.domPostsInProcess.size,
        visibilityTrackerStats: this.visibilityTracker?.getStats?.() || {},
      };
      
      console.log("[CMN] 📊 COLLECTION SUMMARY:", stats);
      console.log("[CMN] 📊 STATS:", stats);
      console.log("[CMN] ⚙️ Config:", this.config);
      console.log("[CMN] 📋 Queue:", this.storageManager.queue.slice(0, 3)); // First 3 items
      return stats;
    }

    destroy() {
      this.stop();
      if (this.storageManager) {
        this.storageManager.destroy();
      }
      if (this.visibilityTracker) {
        this.visibilityTracker.stop();
      }
    }
  }

  // Initialize
  const main = new CheckMyNewsMain();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => main.init());
  } else {
    main.init();
  }

  // Expose for debugging
  window.CMN = main;
})();
