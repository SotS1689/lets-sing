import { defineConfig } from "vite";

export default defineConfig({
    // Relative asset paths, so the built site works from any folder
    // (e.g. https://<user>.github.io/<repo>/) without reconfiguring.
    base: "./",
    server: { host: true },
});
