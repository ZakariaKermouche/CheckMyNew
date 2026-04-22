(function () {

  function detectUI(source) {

    let version = "unknown";
    let mobile = false;

    try {
      mobile =
        /Mobi|Android|iPhone/i.test(navigator.userAgent) ||
        window.innerWidth < 720;

      const hasMain = !!document.querySelector("div[role='main']");
      const hasReactRoot =
        !!document.querySelector("div[id^='mount_']") ||
        !!document.querySelector("div[data-visualcompletion]");

      const hasClassic =
        document.querySelector("#blueBarDOMInspector") ||
        document.querySelector("#pagelet_bluebar") ||
        document.querySelector("#leftCol");

      if (hasMain && hasReactRoot && !hasClassic) {
        version = "comet";
      }



      window.dispatchEvent(
        new CustomEvent("CMN_UI_DETECTED", {
          detail: { version, mobile },
        })
      );

    } catch (e) {
    }
  }

  // DO NOT run immediately
  // Facebook DOM is NOT ready at document_start
  function detectUIWithRetry(attempt = 1, maxAttempts = 5) {

    // Check if DOM is ready
    const hasMinimalDOM =
      document.querySelector('div[role="main"]') ||
      document.querySelector("#mount_0_0");

    if (!hasMinimalDOM && attempt < maxAttempts) {
      // Retry with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      setTimeout(() => detectUIWithRetry(attempt + 1, maxAttempts), delay);
      return;
    }

    detectUI(`attempt-${attempt}`);
  }

  // Start detection when DOM is interactive
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => detectUIWithRetry());
  } else {
    detectUIWithRetry();
  }
})();
