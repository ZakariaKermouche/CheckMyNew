// content-scripts/fbGraphQLInterceptor.js

class FBGraphQLInterceptor {
  constructor() {
    this.started = false;

    if (!window.__CMN_GRAPHQL_STORE__) {
      window.__CMN_GRAPHQL_STORE__ = new Map();
    }

    if (!window.__CMN_EXTRACTED_POSTS__) {
      window.__CMN_EXTRACTED_POSTS__ = [];
    }

    if (!window.__CMN_WAIST_DOC_IDS__) {
      window.__CMN_WAIST_DOC_IDS__ = new Map();
    }
    if (!window.__CMN_WAIST_DOC_ID__) {
      window.__CMN_WAIST_DOC_ID__ = null;
    }

    this.store = window.__CMN_GRAPHQL_STORE__;
    this.originalFetch = window.fetch;
    this.originalXHR = window.XMLHttpRequest;
    this.interceptStats = { fetch: 0, xhr: 0 };
    this.fetchWrapper = null;
    this.xhrWrapper = null;
  }

  normalizeRequestUrl(input) {
    if (!input) return "";
    if (typeof input === "string") return input;
    if (typeof input.url === "string") return input.url;
    try {
      return String(input);
    } catch {
      return "";
    }
  }

  emitToContextAndTop(payload) {
    window.postMessage(payload, "*");
    try {
      if (window.top && window.top !== window) {
        window.top.postMessage(payload, "*");
      }
    } catch (_) {}
  }

  /* ---------------- DOC ID CAPTURE ---------------- */

  maybeCaptureDocIdFromBody(body) {
    if (!body) return;

    let params;
    if (typeof body === "string") {
      params = new URLSearchParams(body);
    } else if (body instanceof URLSearchParams) {
      params = body;
    } else {
      return;
    }

    const docId = params.get("doc_id");
    if (!docId) return;

    const friendlyName =
      params.get("fb_api_req_friendly_name") ||
      params.get("fb_api_req_friendly_name[]") ||
      "";

    const cleanName = friendlyName.replace(/\\.graphql$/, "");

    const looksLikeWaist =
      /WAIST|AdPrefs|AdsPref|AdPreference|WhyAmISeeing/i.test(cleanName);

    if (!looksLikeWaist) return;

    window.__CMN_WAIST_DOC_ID__ = docId;
    if (cleanName) {
      window.__CMN_WAIST_DOC_IDS__.set(cleanName, docId);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;

    this.interceptFetch();
    this.interceptXHR();
    setInterval(() => {
      try {
        if (this.fetchWrapper && window.fetch !== this.fetchWrapper) {
          window.fetch = this.fetchWrapper;
        }
        if (this.xhrWrapper && window.XMLHttpRequest !== this.xhrWrapper) {
          window.XMLHttpRequest = this.xhrWrapper;
        }
      } catch (_) {}
    }, 2000);
    // At the end of your GraphQL interceptor
    window.__CMN_GRAPHQL_POSTS__ = window.__CMN_EXTRACTED_POSTS__ || [];

    // Emit custom event when posts are added
    window.addEventListener("CMN_POSTS_EXTRACTED", (event) => {});
  }

  /* ---------------- FETCH ---------------- */

  interceptFetch() {
    const self = this;

    const wrappedFetch = async function (...args) {
      try {
        const url = self.normalizeRequestUrl(args[0]);
        const init = args[1] || {};
        if (url.includes("graphql")) {
          self.maybeCaptureDocIdFromBody(init.body);
        }
      } catch (_) {}

      const response = await self.originalFetch.apply(this, args);
      try {
        const url = self.normalizeRequestUrl(args[0]);
        if (url.includes("graphql")) {
          self.interceptStats.fetch += 1;
          response
            .clone()
            .text()
            .then((text) => self.parseGraphQLText(text))
            .catch(() => {});
        }
      } catch (e) {}

      return response;
    };
    self.fetchWrapper = wrappedFetch;
    window.fetch = wrappedFetch;
  }

  /* ---------------- XHR ---------------- */

  interceptXHR() {
    const self = this;

    const WrappedXHR = function () {
      const xhr = new self.originalXHR();

      const open = xhr.open;
      xhr.open = function (method, url, ...rest) {
        this.__cmn_url = self.normalizeRequestUrl(url);
        return open.call(this, method, url, ...rest);
      };

      const send = xhr.send;
      xhr.send = function (body) {
        if (this.__cmn_url?.includes("graphql")) {
          self.maybeCaptureDocIdFromBody(body);
        }
        try {
          return send.call(this, body);
        } catch (e) {
          const badExtensionUrl =
            typeof this.__cmn_url === "string" &&
            this.__cmn_url.startsWith("chrome-extension://invalid/");
          if (badExtensionUrl) {
            return;
          }
          throw e;
        }
      };

      xhr.addEventListener("load", function () {
        if (!this.__cmn_url?.includes("graphql")) return;
        self.interceptStats.xhr += 1;

        // Get response text
        let text = "";
        if (typeof this.responseText === "string" && this.responseText.length) {
          text = this.responseText;
        } else if (this.response instanceof ArrayBuffer) {
          text = new TextDecoder("utf-8").decode(this.response);
        } else if (this.response && typeof this.response === "object") {
          try {
            text = JSON.stringify(this.response);
          } catch (_) {}
        }

        if (!text) return;

        self.parseGraphQLText(text);
      });

      return xhr;
    };
    self.xhrWrapper = WrappedXHR;
    window.XMLHttpRequest = WrappedXHR;
  }

  /* ---------------- PARSING ---------------- */
  parseJsonSafely(text) {
    if (!text) return null;

    // ✅ FIX: Facebook sends MULTIPLE JSON objects separated by newlines
    // Each line is a complete GraphQL response for a different feed segment

    const results = [];
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      line = line.replace(/^for\s*\(;;\);\s*/, "");
      line = line.replace(/^\)\]\}'\s*/, "");

      if (!line) continue; // Skip empty lines

      try {
        const parsed = JSON.parse(line);
        results.push(parsed);
      } catch (e) {
        // Continue to next line instead of stopping
      }
    }

    // If we got multiple results, merge them
    if (results.length > 1) {
      // Return a combined object with all data
      return {
        data: {},
        extensions: {},
        // Merge all the data together
        _allResults: results,
      };
    }

    if (results.length === 1) {
      return results[0];
    }

    throw new Error(
      `Could not parse any valid JSON from ${lines.length} lines`
    );
  }

  parseGraphQLText(text) {
    if (!text) return;
    try {
      const jsonData = this.parseJsonSafely(text);
      const posts = this.extractFacebookPosts(jsonData);
      this.handleExtractedPosts(posts);
    } catch (e) {
      // Fallback parser for payloads that are not line-delimited JSON.
      try {
        const blocks = this.extractJSONBlocks(text);
        if (!Array.isArray(blocks) || blocks.length === 0) return;

        const extracted = [];
        for (const block of blocks) {
          try {
            const parsed = JSON.parse(block);
            const post = this.extractPostData(parsed);
            if (post) extracted.push(post);
          } catch (_) {}
        }
        this.handleExtractedPosts(extracted);
      } catch (_) {}
    }
  }

  handleExtractedPosts(posts) {
    if (!Array.isArray(posts) || posts.length === 0) return;

    window.__CMN_EXTRACTED_POSTS__ =
      window.__CMN_EXTRACTED_POSTS__.concat(posts);

    sessionStorage.setItem(
      "__CMN_EXTRACTED_POSTS__",
      JSON.stringify(window.__CMN_EXTRACTED_POSTS__)
    );

    window.dispatchEvent(
      new CustomEvent("CMN_POSTS_EXTRACTED", {
        detail: {
          posts: posts,
          count: posts.length,
          timestamp: Date.now(),
        },
      })
    );

    // Also bridge through postMessage for content-script isolated world reliability.
    this.emitToContextAndTop({
      source: "CMN_PAGE",
      type: "CMN_GRAPHQL_POSTS",
      posts,
      count: posts.length,
      timestamp: Date.now(),
      frameHref: location.href,
    });
  }
  extractJSONBlocks(text) {
    const results = [];
    let depth = 0;
    let start = -1;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = text.slice(start, i + 1);
          if (candidate.includes('"__typename":"Story"')) {
            results.push(candidate);
          }
          start = -1;
        }
      }
    }

    return results;
  }
  /**
   * Extract post information from a Story node
   */
  extractPostData(storyNode) {
    if (
      !storyNode ||
      storyNode.__typename !== "Story" ||
      !storyNode.viewability_config
    ) {
      return null;
    }
    const post = {
      id: storyNode.id,
      post_id: storyNode.post_id,
      type: storyNode.__typename,
      creation_time:
        storyNode.comet_sections.context_layout.story.comet_sections.metadata[1]
          .story?.creation_time || null,
      author: null,
      message: null,
      url: null,
      privacy:
        storyNode.comet_sections.context_layout.story.comet_sections
          ?.metadata[2]?.story.privacy_scope ||
        storyNode.comet_sections.context_layout.story.comet_sections
          ?.metadata[1]?.story.privacy_scope ||
        null,
      is_attachment:
        Array.isArray(storyNode.attachments) &&
        storyNode.attachments.length > 0,
      attachments: [],
      images: [], // To be filled from attachments
      videos: [], // To be filled from attachments

      to: null,
      ad: null,
      engagment: {
        reaction_count:
          storyNode.comet_sections.feedback?.story.story_ufi_container.story
            .feedback_context.feedback_target_with_context
            .comet_ufi_summary_and_actions_renderer.feedback.reaction_count
            .count || null,
        comment_count:
          storyNode.comet_sections.feedback?.story.story_ufi_container.story
            .feedback_context.feedback_target_with_context
            .comet_ufi_summary_and_actions_renderer.feedback
            ?.comment_rendering_instance?.comments?.total_count || null,
        share_count:
          storyNode.comet_sections.feedback?.story.story_ufi_container.story
            .feedback_context.feedback_target_with_context
            .comet_ufi_summary_and_actions_renderer.feedback.share_count
            .count || null,
      },
    };

    // Extract ad information if present
    if (storyNode.th_dat_spo) {
      post.ad = {
        ad_id: storyNode.th_dat_spo.lbl_adv_iden || null,
        client_token: storyNode.th_dat_spo.client_token || null,
        url: storyNode.comet_sections.content.story.attachments[0].styles
          .attachment?.story_attachment_link_renderer?.attachment?.url,
      };
    }

    // --- Extract attachments (ads & link cards) ---
    if (Array.isArray(storyNode.attachments)) {
      post.attachments = storyNode.attachments.map((att) => {
        const med = att.media;
        const type = med?.__typename;
        const style = att.styles;
        const attachment = style?.attachment;
        const media = attachment?.media;
        const linkRenderer = attachment?.story_attachment_link_renderer;
        const webLink = linkRenderer?.attachment?.web_link;

        return {
          type: type || null,
          id: med?.id || null,

          image: {
            flexible: media?.flexible_height_share_image?.uri || null,
            large: media?.large_share_image?.uri || null,
            width: media?.flexible_height_share_image?.width || null,
            height: media?.flexible_height_share_image?.height || null,
          },

          title: attachment?.title_with_entities?.text || null,

          destination_url: webLink?.url || null,
          fbclid: webLink?.fbclid || null,

          action_links:
            linkRenderer?.attachment?.action_links?.map((a) => a.url) || [],
        };
      });

      post.attachment_count = post.attachments.length;
    }
    if (Array.isArray(storyNode.attachments)) {
      post.images = storyNode.attachments
        .map((att) => {
          const media = att.media;
          const type = media?.__typename;
          const mediaa = att.styles?.attachment?.media;
          if (type === "Photo") {
            return {
              id: mediaa?.id || null,
              photo_image: mediaa?.photo_image?.uri || null,
              height: mediaa?.photo_image?.height || null,
              width: mediaa?.photo_image?.width || null,
              url: mediaa?.url || null,
            };
          }
          return null;
        })
        .filter(Boolean);

      post.videos = storyNode.attachments
        .map((att) => {
          const type = att.media?.__typename;
          const mediaa = att.styles?.attachment?.media;
          if (type === "Video") {
            return {
              videoId: mediaa?.videoId || null,
              thumbnailImage: mediaa?.thumbnailImage?.uri || null,
              url: mediaa?.url || null,
            };
          }
          return null;
        })
        .filter(Boolean);
    }

    // Extract author information
    if (storyNode.actors && storyNode.actors.length > 0) {
      const actor = storyNode.actors[0];
      post.author = {
        name: actor.name,
        id: actor.id,
        page: actor.url,
        type: actor.__typename,
        profile_picture:
          storyNode.comet_sections?.header?.story?.comet_sections?.actor_photo
            ?.story?.actors?.[0]?.profile_picture?.uri ||
          storyNode.comet_sections?.context_layout?.story?.comet_sections
            ?.actor_photo?.story?.actors?.[0]?.profile_picture?.uri ||
          null,
      };
    }

    //extract group information
    if (storyNode.to && storyNode.to.__typename === "Group") {
      const group = storyNode.to;
      post.to = {
        id: group.id,
        name: group.name,
        url: group.url,
      };
    }

    // Extract message/text content
    try {
      // Path 1: comet_sections.content.story.message.text
      if (storyNode.comet_sections?.content?.story?.message?.text) {
        post.message = storyNode.comet_sections.content.story.message.text;
      }
      // Path 2: comet_sections.content.message_container.story.message.text
      else if (
        storyNode.comet_sections?.content?.message_container?.story?.message
          ?.text
      ) {
        post.message =
          storyNode.comet_sections.content.message_container.story.message.text;
      }
    } catch (e) {
      // Message extraction failed, leave as null
    }

    // Extract URL
    try {
      // Path 1: comet_sections.content.story.wwwURL
      if (storyNode.comet_sections?.content?.story?.wwwURL) {
        post.url = storyNode.comet_sections.content.story.wwwURL;
      }
      // Path 2: url field
      else if (storyNode.url) {
        post.url = storyNode.url;
      }
    } catch (e) {
      // URL extraction failed
    }

    // Extract feedback (reactions, comments)
    if (storyNode.feedback?.id) {
      post.feedback_id = storyNode.feedback.id;
    }

    // Extract privacy/audience
    try {
      const privacyScope =
        storyNode.comet_sections?.context_layout?.story?.privacy_scope;
      if (privacyScope) {
        post.privacy = {
          icon: privacyScope.icon_image?.name,
          description: privacyScope.description,
        };
      }
    } catch (e) {
      // Privacy extraction failed
    }
    return post;
  }

  extractAdExplanationDetails(storyNode) {
    const details = {
      explanation_text: null,
      reasons: [],
      advertisers: [],
      client_token: null,
    };

    const textKeys = new Set([
      "ad_explanation",
      "ad_explanation_text",
      "ad_explanation_body",
      "explanation",
    ]);
    const reasonKeys = new Set([
      "ad_targeting_reasons",
      "ad_targeting_reason",
      "ad_targeting",
      "targeting_reasons",
      "targeting_reason",
    ]);
    const advertiserKeys = new Set([
      "advertiser",
      "advertisers",
      "ad_advertiser",
      "sponsor",
      "sponsored_by",
    ]);
    const clientTokenKeys = new Set([
      "client_token",
      "ad_client_token",
      "ad_client_token_id",
    ]);

    const addReason = (val) => {
      if (typeof val === "string") {
        const t = val.trim();
        if (t.length > 8) details.reasons.push(t);
      }
    };

    const addAdvertiser = (val) => {
      if (typeof val === "string") {
        const t = val.trim();
        if (t.length > 1) details.advertisers.push(t);
      } else if (val && typeof val === "object") {
        const name = val.name || val.title || val.text;
        if (typeof name === "string" && name.trim().length > 1) {
          details.advertisers.push(name.trim());
        }
      }
    };

    const stack = [{ obj: storyNode, depth: 0 }];
    const maxDepth = 8;

    while (stack.length) {
      const { obj, depth } = stack.pop();
      if (!obj || typeof obj !== "object" || depth > maxDepth) continue;

      for (const key in obj) {
        const val = obj[key];

        if (textKeys.has(key) && !details.explanation_text) {
          if (typeof val === "string" && val.trim()) {
            details.explanation_text = val.trim();
          } else if (val && typeof val === "object") {
            const text = val.text || val.body || val.title;
            if (typeof text === "string" && text.trim()) {
              details.explanation_text = text.trim();
            }
          }
        }

        if (reasonKeys.has(key)) {
          if (Array.isArray(val)) {
            val.forEach(addReason);
          } else {
            addReason(val);
          }
        }

        if (advertiserKeys.has(key)) {
          if (Array.isArray(val)) {
            val.forEach(addAdvertiser);
          } else {
            addAdvertiser(val);
          }
        }

        if (clientTokenKeys.has(key) && !details.client_token) {
          if (typeof val === "string" && val.trim().length > 3) {
            details.client_token = val.trim();
          }
        }

        if (val && typeof val === "object") {
          stack.push({ obj: val, depth: depth + 1 });
        }
      }
    }

    // Deduplicate
    details.reasons = [...new Set(details.reasons)];
    details.advertisers = [...new Set(details.advertisers)];

    return details;
  }
  extractFacebookPosts(jsonData) {
    const posts = [];

    const responses = jsonData._allResults ? jsonData._allResults : [jsonData];

    for (const response of responses) {
      // Recursive search for Story nodes
      const findStories = (obj, depth = 0) => {
        if (depth > 30) return; // Prevent infinite recursion

        if (obj && typeof obj === "object") {
          // Check if this node is a Story
          if (obj.__typename === "Story") {
            const postData = this.extractPostData(obj);
            if (postData) {
              posts.push(postData);
            }
          }

          // Recurse into all properties
          for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
              findStories(obj[key], depth + 1);
            }
          }
        } else if (Array.isArray(obj)) {
          for (const item of obj) {
            findStories(item, depth + 1);
          }
        }
      };

      findStories(response);
    }
    if (posts.length > 0) {
    }

    return posts;
  }
  walk(obj, cb) {
    if (!obj || typeof obj !== "object") return;
    cb(obj);
    for (const key in obj) {
      try {
        this.walk(obj[key], cb);
      } catch (_) {}
    }
  }

  getStats() {
    return {
      started: this.started,
      cachedStories: this.store.size,
    };
  }
}

// -------------------------------------------
// GraphQL explanation fetcher (page context)
// -------------------------------------------

function encodeFormBody(obj) {
  return Object.keys(obj)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`)
    .join("&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveDocId() {
  if (window.__CMN_WAIST_DOC_ID__) {
    return { id: window.__CMN_WAIST_DOC_ID__, module: "captured" };
  }

  if (window.__CMN_WAIST_DOC_IDS__?.size) {
    const first = window.__CMN_WAIST_DOC_IDS__.entries().next();
    if (!first.done) {
      const [name, id] = first.value;
      return { id, module: `captured:${name}` };
    }
  }

  const knownModules = [
    "CometAdPrefsWAISTDialogRootQuery$Parameters",
    "CometAdPrefsWAISTYouthDialogRootQuery$Parameters",
    "AdsPrefWAISTDialogQuery$Parameters",
  ];

  for (const name of knownModules) {
    try {
      const mod = require(name);
      const id = mod?.params?.id || mod?.id;
      if (id) return { id, module: name };
    } catch (_) {}
  }

  try {
    const moduleMap = require("moduleMap") || {};
    const candidates = Object.keys(moduleMap).filter((m) =>
      /WAIST|AdPrefs|AdsPref|AdPreference|WhyAmISeeing/i.test(m)
    );
    for (const name of candidates) {
      if (!name.endsWith("$Parameters")) continue;
      try {
        const mod = require(name);
        const id = mod?.params?.id || mod?.id;
        if (id) return { id, module: name };
      } catch (_) {}
    }
  } catch (_) {}

  return null;
}

async function fetchAdExplanationGraphQL({ adId, clientToken }) {
  if (!adId || !clientToken) {
    throw new Error("missing_adId_or_clientToken");
  }

  if (typeof require !== "function") {
    throw new Error("require_unavailable");
  }

  const asyncParams = require("getAsyncParams")("POST");

  let docId = null;
  let docModuleName = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const resolved = await resolveDocId();
    if (resolved?.id) {
      docId = resolved.id;
      docModuleName = resolved.module;
      break;
    }
    await sleep(300);
  }

  if (!docId) {
    throw new Error("doc_id_not_found");
  }

  if (docModuleName) {
  }

  const operationName = docModuleName
    ? docModuleName.replace(/\$Parameters$/, "")
    : "CometAdPrefsWAISTDialogRootQuery";

  const requestId = `${Date.now()}_${adId}`;

  const fieldsPayload = {
    ad_id: adId,
    client_token: clientToken,
    entrypoint: "DESKTOP_WAIST_DIALOG",
    request_id: requestId,
  };

  const variableCandidates = /YouthDialog/i.test(operationName)
    ? [
        { adId, fields: fieldsPayload },
        { fields: fieldsPayload },
        { adId, clientToken },
      ]
    : [
        { adId, fields: fieldsPayload },
        { adId, clientToken },
        { fields: fieldsPayload },
      ];

  const isMissingRequiredVariable = (text) => {
    if (!text) return false;
    const cleaned = text.startsWith("for (;;);")
      ? text.replace("for (;;);", "")
      : text;
    try {
      const json = JSON.parse(cleaned);
      const errors = json?.errors || [];
      return errors.some((err) => {
        const msg = String(err?.message || "").toLowerCase();
        const code = err?.code || err?.api_error_code;
        return (
          msg.includes("missing_required_variable_value") || code === 1675012
        );
      });
    } catch {
      return false;
    }
  };

  let lastError = null;

  for (const variables of variableCandidates) {
    const body = {
      ...asyncParams,
      av: asyncParams.__user,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: operationName,
      variables: JSON.stringify(variables),
      doc_id: docId,
    };

    const resp = await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encodeFormBody(body),
    });

    if (!resp.ok) {
      lastError = new Error(`HTTP ${resp.status}`);
      continue;
    }

    const text = await resp.text();
    if (isMissingRequiredVariable(text)) {
      lastError = new Error("missing_required_variable_value");
      continue;
    }

    return text;
  }

  throw lastError || new Error("graphql_explanation_failed");
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const data = event.data || {};
  if (data.source !== "CMN_CONTENT") return;
  if (data.type !== "CMN_FETCH_AD_EXPLANATION") return;

  const requestId = data.requestId;
  try {
    const responseText = await fetchAdExplanationGraphQL({
      adId: data.adId,
      clientToken: data.clientToken,
    });

    window.postMessage(
      {
        source: "CMN_PAGE",
        type: "CMN_EXPLANATION_RESPONSE",
        requestId,
        ok: true,
        responseText,
      },
      "*"
    );
  } catch (e) {
    window.postMessage(
      {
        source: "CMN_PAGE",
        type: "CMN_EXPLANATION_RESPONSE",
        requestId,
        ok: false,
        error: e?.message || String(e),
      },
      "*"
    );
  }
});

/* ---------------- BOOTSTRAP ---------------- */

(function () {
  const interceptor = new FBGraphQLInterceptor();
  interceptor.start();
  window.__CMN_GRAPHQL_INTERCEPTOR__ = interceptor;
  interceptor.emitToContextAndTop({
    source: "CMN_PAGE",
    type: "CMN_GRAPHQL_READY",
    ts: Date.now(),
    frameHref: location.href,
  });
  setInterval(() => {
    interceptor.emitToContextAndTop({
      source: "CMN_PAGE",
      type: "CMN_GRAPHQL_TAP",
      fetch: interceptor.interceptStats.fetch,
      xhr: interceptor.interceptStats.xhr,
      fetch_hooked: window.fetch === interceptor.fetchWrapper,
      xhr_hooked: window.XMLHttpRequest === interceptor.xhrWrapper,
      href: location.href,
      frameHref: location.href,
    });
  }, 5000);
})();
