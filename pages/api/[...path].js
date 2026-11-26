/* The existing POS API is mounted behind Next while its feature modules are migrated. */
process.env.VERCEL = process.env.VERCEL || "1";
const legacyServer = require("../../server");

async function handler(req, res) {
  return legacyServer(req, res);
}

handler.config = {
  api: { bodyParser: false, externalResolver: true, responseLimit: false },
};

module.exports = handler;
