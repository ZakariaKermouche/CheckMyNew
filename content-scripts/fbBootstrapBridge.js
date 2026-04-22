
class FBBootstrapBridge {
  constructor(onPost) {
    this.onPost = onPost;
    this.listener = this.handleMessage.bind(this);
  }

  start() {
    window.addEventListener("message", this.listener);
  }

  stop() {
    window.removeEventListener("message", this.listener);
  }

  handleMessage(event) {
    if (event.source !== window) return;
    if (event.data?.source !== "CMN_BOOTSTRAP") return;
    const payload = event.data.payload;
    if (Array.isArray(payload)) {
      payload.forEach((post) => this.onPost(post));
      return;
    }
    this.onPost(payload);
  }
}

window.FBBootstrapBridge = FBBootstrapBridge;
