"use strict";

const fs = require("fs");
const { WinkClient } = require("./wink_client");

async function reportPacket(packet) {
  let lock;
  try {
    if (packet.firstRunMarker) {
      if (fs.existsSync(packet.firstRunMarker)) return;
      lock = `${packet.firstRunMarker}.lock`;
      // An interrupted worker's lock expires; the first-run event retries on a later run.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.unlinkSync(lock); } catch (_) {}
      try { fs.writeFileSync(lock, "", { flag: "wx", mode: 0o600 }); }
      catch (_) { lock = null; return; }
      if (fs.existsSync(packet.firstRunMarker)) return;
    }
    const client = new WinkClient({ baseUrl: packet.baseUrl, apiKey: packet.apiKey, accessToken: packet.accessToken });
    const response = await client.reportEvents(packet.events, packet.options);
    if (response.code === 0 && packet.firstRunMarker) {
      fs.writeFileSync(packet.firstRunMarker, "reported\n", { mode: 0o600 });
    }
  } catch (_) { /* Best effort; no retries or logs containing sensitive payloads. */ }
  finally { if (lock) { try { fs.unlinkSync(lock); } catch (_) {} } }
}
if (require.main === module) {
  // Hard deadline also bounds DNS/connect/slow trickle responses in the detached worker.
  const deadline = setTimeout(() => process.exit(0), 3000);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; if (input.length > 65536) process.exit(0); });
  process.stdin.on("end", async () => {
    try { await reportPacket(JSON.parse(input)); } catch (_) {}
    clearTimeout(deadline);
  });
}
module.exports = { reportPacket };
