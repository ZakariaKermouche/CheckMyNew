// offscreen.js
// Handles DOM parsing from service worker requests

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg._offscreen) return;

  const { type, payload } = msg;

  switch (type) {
    case "parseExplanationHtml":
      sendResponse(parseExplanationHtml(payload.html));
      return true;

    case "imagesToDataURLs":
      convertImages(payload.urls).then(sendResponse);
      return true;
    case "parsePreferencesHtml":
      sendResponse(parsePreferencesHtml(payload.html, payload.section));
      return true;
  }

  return false;
});

// -------------------------------------------
// 1) Explanation HTML parser
// -------------------------------------------

function parseExplanationHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // main text
  const allText = doc.body.innerText || "";

  // Reasons (usually bullet points, list items, or labeled spans)
  const reasons = extractReasons(doc);

  // Advertisers mentioned in the explanation
  const advertisers = extractAdvertisers(doc);

  // Links on the page
  const links = [...doc.querySelectorAll("a[href]")]
    .map((a) => a.href)
    .filter(Boolean);

  // Targeting details (FB now wraps them inside span, div, li)
  const targeting_terms = extractTargetingTerms(doc);

  return {
    text: allText.trim(),
    reasons,
    advertisers,
    links,
    targeting_terms,
  };
}

function extractReasons(doc) {
  let reasons = [];

  // typical selector for FB explanation reasons
  const reasonNodes = doc.querySelectorAll("li, div, span");

  reasonNodes.forEach((node) => {
    const txt = node.innerText?.trim();
    if (!txt) return;

    // Filter for segments that mention “why you’re seeing this ad”
    if (
      txt.toLowerCase().includes("you’re seeing this ad because") ||
      txt.toLowerCase().includes("vous voyez cette publicité") ||
      txt.toLowerCase().includes("you are seeing this ad because")
    ) {
      reasons.push(txt);
    }

    // FB sometimes uses bullet or dot
    if (txt.startsWith("•")) reasons.push(txt.slice(1).trim());
  });

  return [...new Set(reasons)];
}

function extractAdvertisers(doc) {
  const advertisers = new Set();

  // FB shows advertiser names as strong, bold, or link elements
  const candidates = doc.querySelectorAll("a, strong, b, span");

  candidates.forEach((el) => {
    const txt = el.innerText?.trim();
    if (!txt) return;

    // very simple heuristic
    if (txt.length > 2 && txt.length < 200) {
      if (
        txt.toLowerCase().includes("from") ||
        txt.toLowerCase().includes("par") ||
        /^[A-Z][A-Za-z0-9 ._-]+$/.test(txt)
      ) {
        advertisers.add(txt);
      }
    }
  });

  return [...advertisers];
}

function extractTargetingTerms(doc) {
  const terms = new Set();

  const nodes = doc.querySelectorAll("li, span, div");

  nodes.forEach((n) => {
    const txt = n.innerText?.trim();
    if (!txt) return;

    // Common phrasing FB uses
    if (
      txt.toLowerCase().includes("based on") ||
      txt.toLowerCase().includes("targeted because") ||
      txt.toLowerCase().includes("matching your profile") ||
      txt.toLowerCase().includes("used the following criteria") ||
      txt.toLowerCase().includes("used your activity to")
    ) {
      terms.add(txt);
    }
  });

  return [...terms];
}

// -------------------------------------------
// 2) Convert image URLs → base64
// -------------------------------------------

async function convertImages(urls) {
  const map = {};

  for (const url of urls) {
    try {
      const blob = await fetch(url).then((r) => r.blob());
      const base64 = await blobToBase64(blob);
      map[url] = base64;
    } catch (e) {
      map[url] = null;
    }
  }

  return { map };
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}
// -------------------------------------------
// 3) Preferences HTML parser
// -------------------------------------------

function parsePreferencesHtml(html, section) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Normalize section
  section = section || "generic";

  if (section === "interests") {
    return {
      interests: extractInterests(doc),
    };
  }

  if (section === "advertisers") {
    const { withContact, targetingYou, hidden } = extractAdvertisersPrefs(doc);

    return {
      advertisers_with_contact: withContact,
      advertisers_targeting_you: targetingYou,
      hidden_advertisers: hidden,
    };
  }

  // fallback
  return {
    interests: [],
    advertisers_with_contact: [],
    advertisers_targeting_you: [],
    hidden_advertisers: [],
  };
}

function extractInterests(doc) {
  const interests = new Set();

  // FB typically shows interests as tiles/cards with labels
  const tiles = doc.querySelectorAll(
    "div[role='button'], div[role='gridcell'], div"
  );

  tiles.forEach((tile) => {
    const text = tile.innerText?.trim();
    if (!text) return;

    // filter out obvious UI noise
    if (text.length < 2 || text.length > 120) return;
    if (text.toLowerCase().includes("ad settings")) return;
    if (text.toLowerCase().includes("data about your activity")) return;

    // simple heuristic: "Interest · Category"
    if (text.includes("·")) {
      const [interest] = text.split("·");
      if (interest.trim().length > 1) {
        interests.add(interest.trim());
      }
    } else {
      interests.add(text);
    }
  });

  return [...interests];
}

function extractAdvertisersPrefs(doc) {
  const withContact = new Set();
  const targetingYou = new Set();
  const hidden = new Set();

  // Headings that usually label the lists
  const sections = doc.querySelectorAll("h2, h3, h4");

  sections.forEach((heading) => {
    const title = heading.innerText?.toLowerCase() || "";
    let bucket = null;

    if (
      title.includes("uploaded a list") ||
      title.includes("list with your information") ||
      title.includes("ont téléchargé une liste") ||
      title.includes("ajouté votre liste")
    ) {
      bucket = withContact;
    } else if (
      title.includes("who have shown you ads") ||
      title.includes("shown you ads using a list") ||
      title.includes("you’ve seen ads from") ||
      title.includes("vous avez vu des publicités de")
    ) {
      bucket = targetingYou;
    } else if (
      title.includes("you have hidden") ||
      title.includes("advertisers you’ve hidden") ||
      title.includes("annonceurs masqués")
    ) {
      bucket = hidden;
    }

    if (!bucket) return;

    // find the list under this heading
    let container = heading.nextElementSibling;
    while (
      container &&
      container.tagName.toLowerCase() !== "ul" &&
      !container.querySelector("li")
    ) {
      container = container.nextElementSibling;
    }
    if (!container) return;

    const items = container.querySelectorAll("li, div[role='listitem']");
    items.forEach((item) => {
      const nameEl = item.querySelector("strong, span, a") || item;
      const name = nameEl.innerText?.trim();
      if (!name) return;
      if (name.length < 2 || name.length > 150) return;
      bucket.add(name);
    });
  });

  return {
    withContact: [...withContact],
    targetingYou: [...targetingYou],
    hidden: [...hidden],
  };
}
