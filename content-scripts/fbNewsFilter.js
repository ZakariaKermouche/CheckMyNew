// content-scripts/fbNewsFilter.js

class FBNewsFilter {
  constructor() {
    this.newsDomains = this.loadNewsDomains();
    this.customDomains = [];
  }

  // Load news domains list
  loadNewsDomains() {
    // Default news domains
    return [
      // US News
      "nytimes.com",
      "washingtonpost.com",
      "wsj.com",
      "usatoday.com",
      "latimes.com",
      "chicagotribune.com",
      "nydailynews.com",

      // Broadcast News
      "cnn.com",
      "foxnews.com",
      "nbcnews.com",
      "abcnews.go.com",
      "cbsnews.com",
      "msnbc.com",

      // International
      "bbc.com",
      "bbc.co.uk",
      "theguardian.com",
      "telegraph.co.uk",
      "independent.co.uk",
      "lemonde.fr",
      "elpais.com",

      // Wire Services
      "reuters.com",
      "apnews.com",
      "afp.com",

      // Tech News
      "techcrunch.com",
      "theverge.com",
      "wired.com",
      "arstechnica.com",

      // Business
      "bloomberg.com",
      "forbes.com",
      "fortune.com",
      "businessinsider.com",

      // Add more as needed
    ];
  }

  // Check if post is from news source
  isNewsPost(postData) {
    if (!postData || !postData.externalUrl) {
      return false;
    }

    const domain = postData.externalDomain;
    if (!domain) return false;

    // Check against news domains
    return this.isNewsDomain(domain);
  }

  // Check if domain is a news domain
  isNewsDomain(domain) {
    if (!domain) return false;

    const normalizedDomain = domain.toLowerCase().replace("www.", "");

    // Check exact match
    if (this.newsDomains.includes(normalizedDomain)) {
      return true;
    }

    // Check if any news domain is contained in the domain
    return this.newsDomains.some(
      (newsDomain) =>
        normalizedDomain.includes(newsDomain) ||
        newsDomain.includes(normalizedDomain)
    );
  }

  // Add custom domain
  addCustomDomain(domain) {
    const normalized = domain.toLowerCase().replace("www.", "");
    if (!this.customDomains.includes(normalized)) {
      this.customDomains.push(normalized);
      this.newsDomains.push(normalized);
    }
  }

  // Remove custom domain
  removeCustomDomain(domain) {
    const normalized = domain.toLowerCase().replace("www.", "");
    const index = this.customDomains.indexOf(normalized);
    if (index > -1) {
      this.customDomains.splice(index, 1);
      const newsIndex = this.newsDomains.indexOf(normalized);
      if (newsIndex > -1) {
        this.newsDomains.splice(newsIndex, 1);
      }
    }
  }

  // Get domain category
  getDomainCategory(domain) {
    if (!domain) return null;

    const categories = {
      mainstream: ["nytimes.com", "washingtonpost.com", "cnn.com", "bbc.com"],
      wire: ["reuters.com", "apnews.com", "afp.com"],
      tech: ["techcrunch.com", "theverge.com", "wired.com"],
      business: ["bloomberg.com", "forbes.com", "wsj.com"],
    };

    for (const [category, domains] of Object.entries(categories)) {
      if (domains.some((d) => domain.includes(d))) {
        return category;
      }
    }

    return "other";
  }

  // Get all domains
  getAllDomains() {
    return [...this.newsDomains];
  }

  // Get custom domains only
  getCustomDomains() {
    return [...this.customDomains];
  }
}

// Export
window.FBNewsFilter = FBNewsFilter;
