/* eslint-disable @typescript-eslint/no-require-imports */
const legacyServer = require("../../old_project/server");

async function handler(req, res) {
  await legacyServer.startupPromise;
  return legacyServer.app(req, res);
}

handler.config = {
  api: {
    bodyParser: false,
    externalResolver: true,
    responseLimit: false,
  },
};

module.exports = handler;
