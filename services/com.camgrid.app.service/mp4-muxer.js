'use strict';

// ─── Minimal fragmented-MP4 (fMP4) muxer for H.264 ──────────────────────────────
//
// Takes raw H.264 NAL units (no start codes), grouped into access units, and
// produces ISO-BMFF fragments suitable for MediaSource Extensions:
//
//   • init segment  = ftyp + moov   (carries SPS/PPS in an avcC box)
//   • media segment = moof + mdat   (one access unit, AVCC length-prefixed)
//
// Video-only, 90 kHz timescale (RTP clock for H.264).

const TIMESCALE = 90000;

// ─── Box helpers ────────────────────────────────────────────────────────────────

function box(type, ...payloads) {
  let size = 8;
  for (const p of payloads) size += p.length;
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write(type, 4, 'ascii');
  let offset = 8;
  for (const p of payloads) {
    p.copy(buf, offset);
    offset += p.length;
  }
  return buf;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

// 9-entry 3x3 transform matrix (identity, 16.16 fixed point)
const IDENTITY_MATRIX = Buffer.from([
  0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x00, 0x00, 0x00,
]);

// ─── Init-segment boxes ─────────────────────────────────────────────────────────

function ftyp() {
  return box('ftyp', Buffer.from([
    0x69, 0x73, 0x6f, 0x6d, // 'isom' major brand
    0x00, 0x00, 0x00, 0x01, // minor version
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x69, 0x73, 0x6f, 0x32, // 'iso2'
    0x61, 0x76, 0x63, 0x31, // 'avc1'
    0x6d, 0x70, 0x34, 0x31, // 'mp41'
  ]));
}

function mvhd() {
  const b = Buffer.alloc(100);
  // version(0) + flags(0) already zeroed
  b.writeUInt32BE(TIMESCALE, 12);
  b.writeUInt32BE(0, 16);           // duration (unknown for live)
  b.writeUInt32BE(0x00010000, 20);  // rate 1.0
  b.writeUInt16BE(0x0100, 24);      // volume 1.0
  IDENTITY_MATRIX.copy(b, 36);
  b.writeUInt32BE(0xffffffff, 96);  // next_track_ID (unused)
  return box('mvhd', b);
}

function tkhd(width, height) {
  const b = Buffer.alloc(84);
  b.writeUInt32BE(0x00000007, 0);   // version 0, flags: enabled|in-movie|in-preview
  b.writeUInt32BE(1, 12);           // track_ID
  b.writeUInt32BE(0, 20);           // duration
  IDENTITY_MATRIX.copy(b, 40);
  b.writeUInt32BE(width << 16, 76);
  b.writeUInt32BE(height << 16, 80);
  return box('tkhd', b);
}

function mdhd() {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(TIMESCALE, 12);
  b.writeUInt32BE(0, 16);     // duration
  b.writeUInt16BE(0x55c4, 20); // language 'und'
  return box('mdhd', b);
}

function hdlr() {
  const name = Buffer.from('VideoHandler\0', 'ascii');
  const head = Buffer.alloc(24);
  head.write('vide', 8, 'ascii'); // handler_type
  return box('hdlr', head, name);
}

function vmhd() {
  return box('vmhd', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]));
}

function dinf() {
  const url = box('url ', Buffer.from([0, 0, 0, 1])); // self-contained flag
  const dref = box('dref', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), url);
  return box('dinf', dref);
}

function avcC(sps, pps) {
  const head = Buffer.from([
    0x01,        // configurationVersion
    sps[1],      // AVCProfileIndication
    sps[2],      // profile_compatibility
    sps[3],      // AVCLevelIndication
    0xff,        // 6 bits reserved + lengthSizeMinusOne (3 → 4-byte NAL length)
    0xe1,        // 3 bits reserved + numOfSequenceParameterSets (1)
  ]);
  const spsLen = Buffer.alloc(2); spsLen.writeUInt16BE(sps.length, 0);
  const ppsCount = Buffer.from([0x01]);
  const ppsLen = Buffer.alloc(2); ppsLen.writeUInt16BE(pps.length, 0);
  return box('avcC', head, spsLen, sps, ppsCount, ppsLen, pps);
}

function avc1(sps, pps, width, height) {
  const b = Buffer.alloc(78);
  b.writeUInt16BE(1, 6);              // data_reference_index
  b.writeUInt16BE(width, 24);
  b.writeUInt16BE(height, 26);
  b.writeUInt32BE(0x00480000, 28);   // horiz resolution 72 dpi
  b.writeUInt32BE(0x00480000, 32);   // vert resolution 72 dpi
  b.writeUInt16BE(1, 40);            // frame_count
  b.writeUInt16BE(0x0018, 74);       // depth
  b.writeInt16BE(-1, 76);            // pre_defined
  return box('avc1', b, avcC(sps, pps));
}

function stbl(sps, pps, width, height) {
  const stsd = box('stsd', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), avc1(sps, pps, width, height));
  const stts = box('stts', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]));
  const stsc = box('stsc', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]));
  const stsz = box('stsz', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const stco = box('stco', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]));
  return box('stbl', stsd, stts, stsc, stsz, stco);
}

function trak(sps, pps, width, height) {
  const minf = box('minf', vmhd(), dinf(), stbl(sps, pps, width, height));
  const mdia = box('mdia', mdhd(), hdlr(), minf);
  return box('trak', tkhd(width, height), mdia);
}

function mvex() {
  const trex = box('trex', Buffer.from([
    0, 0, 0, 0,       // version + flags
    0, 0, 0, 1,       // track_ID
    0, 0, 0, 1,       // default_sample_description_index
    0, 0, 0, 0,       // default_sample_duration
    0, 0, 0, 0,       // default_sample_size
    0, 0, 0, 0,       // default_sample_flags
  ]));
  return box('mvex', trex);
}

function buildInitSegment(sps, pps, width, height) {
  const moov = box('moov', mvhd(), trak(sps, pps, width, height), mvex());
  return Buffer.concat([ftyp(), moov]);
}

// ─── Media-segment boxes ────────────────────────────────────────────────────────

const SAMPLE_FLAGS_KEY = 0x02000000;     // I-frame, sync sample
const SAMPLE_FLAGS_NON_KEY = 0x01010000; // depends on others, non-sync

function buildMediaSegment(seq, decodeTime, duration, ctsOffset, sampleData, isKey) {
  const sampleFlags = isKey ? SAMPLE_FLAGS_KEY : SAMPLE_FLAGS_NON_KEY;

  const mfhd = box('mfhd', Buffer.from([0, 0, 0, 0]), u32(seq));

  // tfhd: default-base-is-moof (0x020000)
  const tfhd = box('tfhd', Buffer.from([0, 0x02, 0x00, 0x00]), u32(1));

  // tfdt: 64-bit baseMediaDecodeTime (version 1)
  const tfdtBody = Buffer.alloc(12);
  tfdtBody[0] = 0x01; // version 1
  const hi = Math.floor(decodeTime / 0x100000000);
  const lo = decodeTime % 0x100000000;
  tfdtBody.writeUInt32BE(hi, 4);
  tfdtBody.writeUInt32BE(lo >>> 0, 8);
  const tfdt = box('tfdt', tfdtBody);

  // trun version 1: data-offset + per-sample duration, size, flags, and
  // signed composition-time offset (required for B-frame reordering).
  const trunBody = Buffer.alloc(28);
  trunBody.writeUInt32BE(0x01000f01, 0); // version 1, flags 0x000f01
  trunBody.writeUInt32BE(1, 4);          // sample_count
  // bytes 8..11 = data_offset, patched after moof size is known
  trunBody.writeUInt32BE(duration, 12);
  trunBody.writeUInt32BE(sampleData.length, 16);
  trunBody.writeUInt32BE(sampleFlags, 20);
  trunBody.writeInt32BE(ctsOffset, 24);  // composition time offset (signed)
  const trun = box('trun', trunBody);

  const traf = box('traf', tfhd, tfdt, trun);
  const moof = box('moof', mfhd, traf);

  // data_offset = bytes from start of moof to first byte of mdat payload
  const dataOffset = moof.length + 8;
  // locate trunBody data_offset field inside the assembled moof
  moof.writeInt32BE(dataOffset, moof.length - trun.length + 8 + 8);

  const mdat = box('mdat', sampleData);
  return Buffer.concat([moof, mdat]);
}

// ─── SPS parsing (Exp-Golomb) ───────────────────────────────────────────────────

// Strip emulation-prevention bytes (00 00 03 → 00 00) producing RBSP.
function ebspToRbsp(ebsp) {
  const out = [];
  for (let i = 0; i < ebsp.length; i++) {
    if (i >= 2 && ebsp[i] === 0x03 && ebsp[i - 1] === 0x00 && ebsp[i - 2] === 0x00 &&
        i + 1 < ebsp.length && ebsp[i + 1] <= 0x03) {
      continue;
    }
    out.push(ebsp[i]);
  }
  return Buffer.from(out);
}

class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  bit() {
    const byte = this.buf[this.pos >> 3];
    const b = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  u(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.bit(); return v >>> 0; }
  ue() {
    let zeros = 0;
    while (this.bit() === 0 && this.pos < this.buf.length * 8) zeros++;
    let v = 0;
    for (let i = 0; i < zeros; i++) v = (v << 1) | this.bit();
    return v + (1 << zeros) - 1;
  }
  se() { const k = this.ue(); return (k & 1) ? (k + 1) >> 1 : -(k >> 1); }
}

const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

// Returns { width, height } from an SPS NAL (including the 1-byte NAL header).
function parseSPS(nal) {
  const r = new BitReader(ebspToRbsp(nal.slice(1)));
  const profileIdc = r.u(8);
  r.u(8);  // constraint flags + reserved
  r.u(8);  // level_idc
  r.ue();  // seq_parameter_set_id

  if (HIGH_PROFILES.indexOf(profileIdc) !== -1) {
    const chromaFormat = r.ue();
    if (chromaFormat === 3) r.u(1); // separate_colour_plane_flag
    r.ue();  // bit_depth_luma_minus8
    r.ue();  // bit_depth_chroma_minus8
    r.u(1);  // qpprime_y_zero_transform_bypass_flag
    if (r.u(1)) { // seq_scaling_matrix_present_flag
      const lists = chromaFormat !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) {
        if (r.u(1)) {
          const size = i < 6 ? 16 : 64;
          let lastScale = 8, nextScale = 8;
          for (let j = 0; j < size; j++) {
            if (nextScale !== 0) { nextScale = (lastScale + r.se() + 256) % 256; }
            lastScale = nextScale === 0 ? lastScale : nextScale;
          }
        }
      }
    }
  }

  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (pocType === 1) {
    r.u(1); // delta_pic_order_always_zero_flag
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u(1); // gaps_in_frame_num_value_allowed_flag

  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1); // mb_adaptive_frame_field_flag
  r.u(1); // direct_8x8_inference_flag

  let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
  if (r.u(1)) { // frame_cropping_flag
    cropL = r.ue(); cropR = r.ue(); cropT = r.ue(); cropB = r.ue();
  }

  // Assume 4:2:0 chroma → crop units of 2 (x) and 2*(2-frameMbsOnly) (y)
  const width = widthMbs * 16 - (cropL + cropR) * 2;
  const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropT + cropB) * 2 * (2 - frameMbsOnly);
  return { width, height };
}

function avcCodecString(sps) {
  const hex = (n) => (n < 16 ? '0' : '') + n.toString(16);
  return 'avc1.' + hex(sps[1]) + hex(sps[2]) + hex(sps[3]);
}

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

// Number of frames to buffer at stream start to measure the exact frame
// duration (via GCD of presentation timestamps) before emitting media.
const WARMUP_FRAMES = 24;

// ─── Muxer ──────────────────────────────────────────────────────────────────────

class Mp4Muxer {
  // send(buffer) delivers each media segment.
  // onReady(codec, mime, initSegment) fires once when parameter sets are known.
  constructor(send, onReady) {
    this.send = send;
    this.onReady = onReady;
    this.sps = null;
    this.pps = null;
    this.ready = false;
    this.seq = 1;
    // Timing state. RTP carries presentation time (PTS) only; frames arrive in
    // decode order. We place each sample's composition time at its real PTS
    // (zero added delay — a shallow decoder DPB can't absorb extra latency) and
    // lay DTS on a uniform grid of the measured frame duration so durations are
    // even and the only buffering is the intrinsic B-frame reorder depth.
    this.pts0 = null;       // first frame's raw RTP timestamp
    this.ptsUnwrapped = 0;  // PTS relative to pts0, 32-bit-wrap corrected
    this.prevRtp = 0;       // previous raw RTP timestamp (for wrap detection)
    this.fd = 0;            // frame duration (90kHz units), measured at warmup
    this.frameIndex = 0;    // decode-order index, drives the uniform DTS grid
    this.warmup = [];       // frames buffered until fd is known
  }

  // nals: array of raw NAL Buffers (no start codes); ts: 32-bit RTP timestamp.
  pushAccessUnit(nals, ts) {
    let isKey = false;
    const samples = [];

    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === 7 && !this.sps) this.sps = nal;
      else if (type === 8 && !this.pps) this.pps = nal;
      if (type === 5) isKey = true;
      if (type === 9 || type === 12) continue; // drop AUD / filler
      samples.push(nal);
    }

    if (!this.ready) {
      if (!(this.sps && this.pps)) return;       // wait for parameter sets
      const dims = parseSPS(this.sps);
      const codec = avcCodecString(this.sps);
      const init = buildInitSegment(this.sps, this.pps, dims.width, dims.height);
      this.onReady(codec, `video/mp4; codecs="${codec}"`, init);
      this.ready = true;
    }

    if (samples.length === 0) return;

    // ── Timing ──────────────────────────────────────────────────────────────
    // Unwrap the 32-bit RTP timestamp into a continuous PTS relative to pts0.
    // (B-frames make per-frame deltas dip negative; only true 32-bit wraps,
    //  i.e. jumps near ±2^31, are corrected.)
    if (this.pts0 === null) {
      this.pts0 = ts;
      this.ptsUnwrapped = 0;
      this.prevRtp = ts;
    } else {
      let d = ts - this.prevRtp;
      if (d > 0x80000000) d -= 0x100000000;
      else if (d < -0x80000000) d += 0x100000000;
      this.ptsUnwrapped += d;
      this.prevRtp = ts;
    }
    const pts = this.ptsUnwrapped;

    // AVCC: 4-byte big-endian length prefix per NAL.
    let total = 0;
    for (const n of samples) total += 4 + n.length;
    const sampleData = Buffer.alloc(total);
    let off = 0;
    for (const n of samples) {
      sampleData.writeUInt32BE(n.length, off); off += 4;
      n.copy(sampleData, off); off += n.length;
    }

    const frame = { pts: pts, sampleData: sampleData, isKey: isKey };

    // Warm up: buffer the first frames to measure the exact frame duration from
    // the GCD of their presentation timestamps (all are multiples of it for a
    // constant-frame-rate source), then flush them with the uniform grid.
    if (this.fd === 0) {
      this.warmup.push(frame);
      if (this.warmup.length >= WARMUP_FRAMES) {
        let g = 0;
        for (const f of this.warmup) g = gcd(g, f.pts);
        this.fd = (g >= 1500 && g <= 7500) ? g : 3600; // sane range ~12–60fps
        for (const f of this.warmup) this.emit(f);
        this.warmup = null;
      }
      return;
    }

    this.emit(frame);
  }

  emit(frame) {
    // Uniform DTS grid; composition time = DTS + CTS = exactly the real PTS, so
    // there is no added presentation delay and no drift from the fd estimate.
    const dts = this.frameIndex * this.fd;
    const ctsOffset = frame.pts - dts; // signed (trun v1); negative for B-frames
    this.frameIndex++;
    const seg = buildMediaSegment(this.seq++, dts, this.fd, ctsOffset, frame.sampleData, frame.isKey);
    this.send(seg, true);
  }
}

module.exports = { Mp4Muxer };
