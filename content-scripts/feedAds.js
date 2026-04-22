// content-scripts/feedAds.js

window.FeedAds = {
  processed: new WeakSet(),

  isSponsored(post) {
    return post.querySelector("a[href*='/ads/about']") !== null;
  },

  extract(post) {
    return {
      // Ad metadata
      isSponsored: true,
      sponsorshipType: this.detectAdType(post),

      // Advertiser
      advertiser: {
        name: this.extractAdvertiserName(post),
        pageId: this.extractAdvertiserPageId(post),
        verifiedBadge: this.hasVerifiedBadge(post),
      },

      // Content
      content: this.extractContent(post),
      externalUrl: this.extractExternalUrl(post),
      externalDomain: this.extractDomain(externalUrl),

      // Call to action
      callToAction: this.extractCTA(post),

      // Standard post data
      postUrl: this.extractPostUrl(post),
      timestamp: Date.now(),
      mediaType: this.detectMediaType(post),

      // Engagement
      reactions: this.extractReactions(post),
      comments: this.extractComments(post),
      shares: this.extractShares(post),
    };
  },

  processAdPost(post) {
    if (this.processed.has(post)) return null;
    if (!this.isSponsored(post)) return null;

    this.processed.add(post);
    return this.extract(post);
  },
};
