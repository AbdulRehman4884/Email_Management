import { serve } from "bun";
import index from "./index.html";

const server = serve({
  port: 3001, // Use port 3001 to avoid conflict with backend on 3000
  routes: {
    // Serve index.html for all unmatched routes (SPA support).
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Frontend server running at ${server.url}`);
