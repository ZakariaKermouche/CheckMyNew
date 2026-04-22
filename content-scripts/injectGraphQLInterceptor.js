// content-scripts/injectGraphQLInterceptor.js

(function inject() {
  if (window.__CMN_GRAPHQL_INJECTED__) return;
  if (!chrome?.runtime?.id) return;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL(
    "page-scripts/fbGraphQLInterceptor.page.js"
  );
  script.setAttribute("data-cmn", "graphql");
  script.onload = () => {
    window.__CMN_GRAPHQL_INJECTED__ = true;
  };
  script.onerror = () => {
    window.__CMN_GRAPHQL_INJECTED__ = false;
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  //   script.type = "text/javascript";

  //   script.onload = () => {
  //     // script.remove();
  //   };

  //   document.documentElement.appendChild(script);
})();
