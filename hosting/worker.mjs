import html from "../dist/index.html";
import { createHostingHandler } from "./handler.mjs";

export default {
  async fetch(request, env) {
    return createHostingHandler(env, { html })(request);
  },
};
