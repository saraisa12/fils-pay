import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The API sets no CORS headers, so the dashboard must call it same-origin. In dev that is this
  // proxy (run with VITE_API_BASE_URL= so the client uses relative paths); hosted, a reverse proxy
  // does the same job.
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://localhost:3000",
    },
  },
});
