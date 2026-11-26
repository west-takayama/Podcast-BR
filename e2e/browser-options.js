const fs = require("node:fs");
// Explicit override, installed system browser, then Playwright managed Chromium.
const executablePath = process.env.E2E_CHROMIUM || ["/usr/bin/chromium", "/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));
module.exports = executablePath ? { executablePath } : {};
