"use strict";
const fs = require("fs");

// QuickTime/ISO-BMFF metadata only; does not decode media or load mdat into memory.
// https://developer.apple.com/documentation/quicktime-file-format/movie_header_atom
// Returns null for unsupported/ambiguous structures so the caller can use ffprobe.
function readMp4Metadata(file, fileSize) {
  const fd = fs.openSync(file, "r");
  let visited = 0;
  try {
    const size = fileSize ?? fs.fstatSync(fd).size;
    const read = (position, length, end = size) => {
      if (!Number.isSafeInteger(position) || position < 0 || position + length > end) throw new Error("truncated box");
      const buffer = Buffer.alloc(length);
      if (fs.readSync(fd, buffer, 0, length, position) !== length) throw new Error("truncated file");
      return buffer;
    };
    const uint64 = (buffer, offset) => {
      const value = buffer.readBigUInt64BE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("unsafe integer");
      return Number(value);
    };
    const boxes = (start, end) => {
      const result = [];
      for (let offset = start; offset < end;) {
        if (++visited > 10000) throw new Error("too many boxes");
        const header = read(offset, 8, end);
        let length = header.readUInt32BE(0), headerSize = 8;
        if (length === 1) { length = uint64(read(offset + 8, 8, end), 0); headerSize = 16; }
        else if (length === 0) length = end - offset;
        if (length < headerSize || length > end - offset) throw new Error("invalid box size");
        result.push({ type: header.toString("latin1", 4, 8), data: offset + headerSize, end: offset + length });
        offset += length;
      }
      return result;
    };
    const children = box => boxes(box.data, box.end);
    const top = boxes(0, size);
    const movies = top.filter(box => box.type === "moov");
    if (movies.length !== 1 || top.some(box => box.type === "moof")) return null;
    const movie = children(movies[0]);
    if (movie.some(box => ["mvex", "cmov"].includes(box.type))) return null;
    const mvhd = movie.find(box => box.type === "mvhd");
    if (!mvhd) return null;
    const version = read(mvhd.data, 1, mvhd.end)[0];
    if (version !== 0 && version !== 1) return null;
    const header = read(mvhd.data, version === 1 ? 32 : 20, mvhd.end);
    const timescale = header.readUInt32BE(version === 1 ? 20 : 12);
    const ticks = version === 1 ? uint64(header, 24) : header.readUInt32BE(16);
    if (!timescale || !ticks || (version === 0 && ticks === 0xffffffff)) return null;
    const duration = ticks / timescale;
    const videos = [];
    for (const trak of movie.filter(box => box.type === "trak")) {
      const track = children(trak);
      const mdia = track.find(box => box.type === "mdia");
      const tkhd = track.find(box => box.type === "tkhd");
      if (!mdia || !tkhd) continue;
      const media = children(mdia);
      const hdlr = media.find(box => box.type === "hdlr");
      if (!hdlr || read(hdlr.data, 12, hdlr.end).toString("latin1", 8, 12) !== "vide") continue;
      const trackVersion = read(tkhd.data, 4, tkhd.end);
      if (trackVersion[0] !== 0 && trackVersion[0] !== 1) return null;
      const dimensionOffset = trackVersion[0] === 1 ? 88 : 76;
      const dimensions = read(tkhd.data + dimensionOffset, 8, tkhd.end);
      let width = dimensions.readUInt32BE(0) / 65536;
      let height = dimensions.readUInt32BE(4) / 65536;
      // Prefer encoded dimensions over tkhd's potentially scaled presentation dimensions.
      const minf = media.find(box => box.type === "minf");
      const stbl = minf && children(minf).find(box => box.type === "stbl");
      const stsd = stbl && children(stbl).find(box => box.type === "stsd");
      if (stsd) {
        const description = read(stsd.data, 8, stsd.end);
        const entries = boxes(stsd.data + 8, stsd.end);
        // Multiple sample descriptions can switch dimensions mid-stream: use ffprobe.
        if (description[0] !== 0 || description.readUInt32BE(4) !== 1 || entries.length !== 1) return null;
        const visual = read(entries[0].data, 28, entries[0].end);
        width = visual.readUInt16BE(24);
        height = visual.readUInt16BE(26);
      }
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return null;
      videos.push({ width, height, enabled: Boolean(trackVersion.readUIntBE(1, 3) & 1) });
    }
    const enabled = videos.filter(video => video.enabled);
    const candidates = enabled.length ? enabled : videos;
    if (candidates.length !== 1) return null;
    return { width: candidates[0].width, height: candidates[0].height, duration };
  } catch (_) {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readMp4Metadata };
