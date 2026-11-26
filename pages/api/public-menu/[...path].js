/* Transitional boundary: guest-menu APIs are migrated incrementally to app/api. */
process.env.VERCEL = process.env.VERCEL || "1";
const legacyServer = require("../../../server");

async function handler(req, res) {
  // The rewrite adds /api for Next's API router; Express owns the public URL.
  req.url = String(req.url || "").replace(/^\/api(?=\/)/, "") || "/";
  req.path = undefined;
  return legacyServer(req, res);
}

handler.config = {
  api: { bodyParser: false, externalResolver: true, responseLimit: false },
};

module.exports = handler;
