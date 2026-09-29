// Vercel serverless function wrapper for the MemoryOps API.
// Reuses the existing createServer() HTTP handler from server.mjs.
import { createServer } from "../server.mjs";

// Cached server instance (cold start creates it once, then reused for warm invocations).
let cachedServer = null;

function getServer() {
  if (!cachedServer) cachedServer = createServer();
  return cachedServer;
}

export default function handler(req, res) {
  return getServer().emit("request", req, res);
}
