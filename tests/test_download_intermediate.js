"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { downloadIntermediate, resultForInput } = require("../skills/wink-cli-usage/scripts/download_intermediate.cjs");

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "wink-chain-test-"));
  const input = path.join(temp, "original photo.png");
  const output = path.join(temp, "steps");
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)]);
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/image" }); res.end(); return; }
    if (req.url === "/html") { res.end("<html>expired result</html>"); return; }
    if (req.url === "/truncated") {
      res.writeHead(200, { "Content-Length": png.length + 20 });
      res.write(png); res.socket.destroy(); return;
    }
    res.writeHead(200, { "Content-Length": png.length, "Content-Type": "image/png" });
    res.write(png.subarray(0, 3)); res.end(png.subarray(3));
  });
  try {
    await fs.writeFile(input, "original must remain unchanged");
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const summary = url => ({ ok: false, results: [
      { file: input, ok: true, result_url: base + url },
      { file: path.join(temp, "another.png"), ok: false },
    ] });
    for (const s of [
      {}, { results: [{ file: input, ok: false, result_url: base + "/image" }] },
      { results: [{ file: "wrong input", ok: true, result_url: base + "/image" }] },
      { results: Array(2).fill({ file: input, ok: true, result_url: base + "/image" }) },
      { results: [{ file: input, ok: true, result_url: "file:///tmp/result.png" }] },
    ]) {
      assert.throws(() => resultForInput(s, input));
      await assert.rejects(downloadIntermediate(s, input, output));
    }
    assert.equal(requests, 0, "failed, ambiguous or unrelated results must never be downloaded");
    const a = await downloadIntermediate(summary("/redirect"), input, output);
    const b = await downloadIntermediate(summary("/image"), input, output);
    assert.notEqual(a.file, b.file, "each successful intermediate must have a unique path");
    assert.equal(a.bytes, png.length);
    assert.equal(path.extname(a.file), ".png");
    assert.deepEqual(await fs.readFile(a.file), png);
    const beforeFailures = await fs.readdir(output);
    await assert.rejects(downloadIntermediate(summary("/html"), input, output), /不是可识别/);
    await assert.rejects(downloadIntermediate(summary("/image"), input, output, 10), /下载上限/);
    await assert.rejects(downloadIntermediate(summary("/truncated"), input, output));
    assert.deepEqual(await fs.readdir(output), beforeFailures, "failed downloads leave no partial input");
    assert.equal(await fs.readFile(input, "utf8"), "original must remain unchanged");
    const json = path.join(temp, "step result.json");
    await fs.writeFile(json, JSON.stringify(summary("/image")));
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.resolve(__dirname, "../skills/wink-cli-usage/scripts/download_intermediate.cjs"),
      "--result-json", json, "--file", input, "--directory", output,
    ]);
    assert.deepEqual(await fs.readFile(JSON.parse(stdout).file), png);
    console.log("Intermediate results: exact successful file selection, redirects, unique media paths, size limits, invalid/truncated responses and CLI passed");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
