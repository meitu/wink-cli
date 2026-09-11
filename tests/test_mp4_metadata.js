"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { readMp4Metadata } = require("../src/mp4_metadata");
// Control only the external-probe boundary; native parsing still reads real files.
const originalExec = childProcess.execFileSync;
let externalCalls = 0, externalMode = "missing";
childProcess.execFileSync = () => {
  externalCalls++;
  if (externalMode === "success") return JSON.stringify({ streams: [{ codec_type: "video", width: 80, height: 60 }], format: { duration: "2.5" } });
  const error = new Error("probe failed");
  if (externalMode === "missing") error.code = "ENOENT";
  throw error;
};
const { probeMedia } = require("../src/cli");
childProcess.execFileSync = originalExec;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wink-mp4-meta-"));

function box(type, payload, wide = false) {
  const header = Buffer.alloc(wide ? 16 : 8);
  header.writeUInt32BE(wide ? 1 : header.length + payload.length);
  header.write(type, 4, 4, "latin1");
  if (wide) header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}
function track(handler = "vide", width = 1920, height = 1080, version = 0) {
  const hdlr = Buffer.alloc(24); hdlr.write(handler, 8);
  const tkhd = Buffer.alloc(version === 1 ? 96 : 84); tkhd[0] = version; tkhd[3] = 1;
  tkhd.writeUInt32BE(width * 65536, version === 1 ? 88 : 76);
  tkhd.writeUInt32BE(height * 65536, version === 1 ? 92 : 80);
  return box("trak", Buffer.concat([box("tkhd", tkhd), box("mdia", box("hdlr", hdlr))]));
}
function movie({ version = 0, ticks = 5666, timescale = 600, extra = Buffer.alloc(0), tracks = [track("soun", 0, 0), track("vide", 1920, 1080, version)], wide = false } = {}) {
  const mvhd = Buffer.alloc(version === 1 ? 112 : 100); mvhd[0] = version;
  mvhd.writeUInt32BE(timescale, version === 1 ? 20 : 12);
  if (version === 1) mvhd.writeBigUInt64BE(BigInt(ticks), 24); else mvhd.writeUInt32BE(ticks, 16);
  return box("moov", Buffer.concat([box("mvhd", mvhd), ...tracks, extra]), wide);
}
function write(name, data) { const file = path.join(dir, name); fs.writeFileSync(file, data); return file; }
try {
  for (const suffix of ["mp4", "mov"]) {
    const file = path.join(__dirname, "fixtures", "video", `sample.${suffix}`);
    assert.deepStrictEqual(probeMedia(file), { width: 32, height: 24, duration: 1.2, size: fs.statSync(file).size });
  }
  assert.strictEqual(externalCalls, 0, "real MP4/MOV must not invoke ffprobe");
  for (const version of [0, 1]) {
    const file = write(`version-${version}.mov`, movie({ version, wide: Boolean(version) }));
    assert.deepStrictEqual(readMp4Metadata(file), { width: 1920, height: 1080, duration: 5666 / 600 });
  }
  const long = write("long.mp4", movie({ version: 1, ticks: 2 ** 32 + 100, timescale: 1000000 }));
  assert.strictEqual(readMp4Metadata(long).duration, (2 ** 32 + 100) / 1000000);

  // A sparse media payload proves tail metadata can be located without scanning video data.
  const sparse = path.join(dir, "large.MOV"), fd = fs.openSync(sparse, "w");
  const mediaSize = 64 * 1024 * 1024;
  const mediaHeader = Buffer.alloc(8); mediaHeader.writeUInt32BE(mediaSize); mediaHeader.write("mdat", 4);
  fs.writeSync(fd, mediaHeader); fs.writeSync(fd, movie(), 0, movie().length, mediaSize); fs.closeSync(fd);
  const originalRead = fs.readSync;
  let bytesRequested = 0;
  fs.readSync = function (handle, buffer, offset, length, position) { bytesRequested += length; return originalRead.call(fs, handle, buffer, offset, length, position); };
  try { assert.strictEqual(probeMedia(sparse).duration, 5666 / 600); }
  finally { fs.readSync = originalRead; }
  assert.ok(bytesRequested < 4096, `only metadata should be read, got ${bytesRequested} bytes`);

  const invalidCases = [
    Buffer.from("broken"), box("free", Buffer.alloc(0)), movie({ timescale: 0 }), movie({ ticks: 0 }),
    movie({ ticks: 0xffffffff }), movie({ version: 1, ticks: 0xffffffffffffffffn }),
    movie({ extra: box("mvex", Buffer.alloc(0)) }), movie({ tracks: [track("soun", 0, 0)] }),
    movie({ tracks: [track(), track()] }), movie().subarray(0, 32),
    Buffer.concat([movie(), box("moof", Buffer.alloc(0))]),
  ];
  for (const [index, data] of invalidCases.entries()) assert.strictEqual(readMp4Metadata(write(`invalid-${index}.mp4`, data)), null);
  const broken = write("broken.mp4", Buffer.from("broken"));
  assert.deepStrictEqual(probeMedia(broken), { size: 6 }, "unrecognized + missing ffprobe still allows submission");
  externalMode = "success";
  assert.deepStrictEqual(probeMedia(broken), { width: 80, height: 60, duration: 2.5, size: 6 }, "native failure falls back to ffprobe");
  const avi = write("video.avi", Buffer.from("video"));
  assert.strictEqual(probeMedia(avi).duration, 2.5, "other video formats retain ffprobe");
  externalMode = "error";
  assert.throws(() => probeMedia(broken), /无法读取媒体信息/, "installed ffprobe errors are not silently ignored");
  console.log("MP4 metadata: real MP4/MOV, 32/64-bit boxes and timing, tail moov, bounded reads, malformed/fragmented files and ffprobe fallback passed");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
