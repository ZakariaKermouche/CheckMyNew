// page-scripts/fbBootstrapExtractor.page.js
// PAGE CONTEXT

class FBBootstrapExtractor {
  constructor() {
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;

    // Track parsed scripts so we don't re-parse the same one
    this._seenScripts = this._seenScripts || new WeakSet();

    // 1) immediate scan
    this.scanOnce();

    // 2) Observe new scripts injected after hydration
    this._observer = new MutationObserver((mutations) => {
      let sawJsonScript = false;

      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (
            n &&
            n.nodeType === 1 &&
            n.tagName === "SCRIPT" &&
            n.getAttribute("type") === "application/json"
          ) {
            sawJsonScript = true;
            break;
          }
        }
        if (sawJsonScript) break;
      }

      // If any application/json script was added, rescan
      if (sawJsonScript) this.scanOnce();
    });

    this._observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  scanOnce() {
    const scripts = document.querySelectorAll(
      'script[type="application/json"]'
    );

    for (const script of scripts) {
      if (this._seenScripts.has(script)) continue;

      const text = script.textContent;
      // mark as seen early to avoid repeated work even if parsing fails
      this._seenScripts.add(script);

      if (!text) continue;

      // Your filter (keep it), but broaden a bit for safety:
      // Some blobs include __bbox without the literal "ScheduledServerJS" string.
      const isCandidate = text.includes('"__typename":"Story"');

      if (!isCandidate) continue;

      const data = JSON.parse(text);
      this.extractFacebookPosts(data);
      // const jsonCandidates = this.extractJSONBlocks(text);
      // for (const jsonText of jsonCandidates) {
      //   try {
      //     const data = JSON.parse(jsonText);
      //     this.extractFacebookPosts(data);
      //   } catch (_) {
      //     // ignore invalid blocks
      //   }
      // }
    }
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
    const contextSections =
      storyNode.comet_sections?.context_layout?.story?.comet_sections || null;
    const metadataItems = Array.isArray(contextSections?.metadata)
      ? contextSections.metadata
      : [];
    const metadataStories = metadataItems
      .map((item) => item?.story)
      .filter(Boolean);
    const creationStory =
      metadataStories.find((item) => item?.creation_time != null) || null;
    const privacyStory =
      metadataStories.find((item) => item?.privacy_scope != null) || null;

    const post = {
      id: storyNode.id,
      post_id: storyNode.post_id,
      type: storyNode.__typename,
      creation_time: creationStory?.creation_time || null,
      author: null,
      attachments: [],
      message: null,
      url: null,
      privacy: privacyStory?.privacy_scope || null,
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
            ?.count || null,
        comment_count:
          storyNode.comet_sections.feedback?.story.story_ufi_container.story
            .feedback_context.feedback_target_with_context
            .comet_ufi_summary_and_actions_renderer.feedback
            ?.comment_rendering_instance?.comments?.total_count || null,
        share_count:
          storyNode.comet_sections.feedback?.story.story_ufi_container.story
            .feedback_context.feedback_target_with_context
            .comet_ufi_summary_and_actions_renderer.feedback.share_count
            ?.count || null,
      },
    };

    // Extract ad information if present
    if (storyNode.th_dat_spo) {
      post.ad = {
        ad_id: storyNode.th_dat_spo.lbl_adv_iden || null,
        client_token: storyNode.th_dat_spo.client_token || null,
        url:
          storyNode.comet_sections?.content?.story?.attachments?.[0]?.styles
            ?.attachment?.story_attachment_link_renderer?.attachment?.url ||
          null,
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
            flexible:
              media?.flexible_height_share_image?.uri ||
              med?.photo_image?.uri ||
              med?.image?.uri ||
              null,
            large:
              media?.large_share_image?.uri || med?.photo_image?.uri || null,
            width:
              media?.flexible_height_share_image?.width ||
              med?.photo_image?.width ||
              null,
            height:
              media?.flexible_height_share_image?.height ||
              med?.photo_image?.height ||
              null,
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

  extractFacebookPosts(jsonData) {
    const posts = [];
    const self = this;
    /**
     * Recursively search for objects where __typename === "Story"
     */
    function findStories(obj, depth = 0, maxDepth = 30) {
      // Safety: stop if too deep
      if (depth > maxDepth) return;

      if (Array.isArray(obj)) {
        // If it's an array, iterate through items
        for (const item of obj) {
          findStories(item, depth + 1, maxDepth);
        }
      } else if (obj !== null && typeof obj === "object") {
        // If it's an object, check if it's a Story node
        if (obj.__typename === "Story") {
          // Found a story post!
          const post = self.extractPostData(obj);
          if (post) {
            posts.push(post);
          }
        }

        // Recurse into all properties
        for (const key in obj) {
          if (obj.hasOwnProperty(key)) {
            findStories(obj[key], depth + 1, maxDepth);
          }
        }
      }
    }

    // Start recursive search
    findStories(jsonData);
    // Send to content script
    if (posts.length > 0) {
      window.postMessage(
        {
          source: "CMN_BOOTSTRAP",
          payload: posts,
        },
        "*"
      );
    }
    return posts;
  }

  walk(obj, cb) {
    if (!obj || typeof obj !== "object") return;
    cb(obj);
    for (const k in obj) {
      try {
        this.walk(obj[k], cb);
      } catch (_) {}
    }
  }
}

// expose like GraphQL
window.__CMN_BOOTSTRAP_EXTRACTOR__ = new FBBootstrapExtractor();
window.__CMN_BOOTSTRAP_EXTRACTOR__.start();
