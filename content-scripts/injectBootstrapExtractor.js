
(function injectBootstrapExtractor() {
  if (window.__CMN_BOOTSTRAP_INJECTED__) return;

  const inject = () => {
    if (!chrome?.runtime?.id) return;
    if (window.__CMN_BOOTSTRAP_INJECTED__) return;
    if (document.querySelector('script[data-cmn="bootstrap"]')) {
      window.__CMN_BOOTSTRAP_INJECTED__ = true;
      return;
    }

    const host = document.head || document.documentElement;
    if (!host) return;

    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL(
        "page-scripts/fbBootstrapExtractor.page.js"
      );
      script.setAttribute("data-cmn", "bootstrap");
      script.onload = () => {
        window.__CMN_BOOTSTRAP_INJECTED__ = true;
      };
      script.onerror = () => {
        window.__CMN_BOOTSTRAP_INJECTED__ = false;
        script.remove();
      };
      host.appendChild(script);
    } catch (error) {
      if (!String(error?.message || error).includes("Extension context invalidated")) {
        throw error;
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject, { once: true });
    return;
  }

  inject();
})();
