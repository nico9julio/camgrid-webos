'use strict';

function log() {
  process.stdout.write('[' + new Date().toISOString() + '] ' + Array.from(arguments).join(' ') + '\n');
}

log('=== TPlayer service starting, node', process.version, '===');

// Keep the service alive through unexpected errors so streaming doesn't die silently.
process.on('uncaughtException', (e) => log('[FATAL] uncaughtException:', e && e.stack || e));
process.on('unhandledRejection', (e) => log('[FATAL] unhandledRejection:', e && e.stack || e));

const net = require('net');
const WebSocket = require('ws');
const pkgInfo = require('./package.json');
const Service = require('webos-service');
const { Mp4Muxer } = require('./mp4-muxer');

const WS_PORT = 9877;

const service = new Service(pkgInfo.name);

let wss = null;
let sessions = {};      // stream index → Session
let diagTimer = null;
let aliases = {};

// Held open for the life of the view so webOS does not reap the (otherwise
// idle) JS service mid-playback. An open Luna subscription keeps it alive.
let streamSub = null;

// ─── WebSocket transport (one server, many multiplexed streams) ──────────────
// Binary frames are prefixed with a 1-byte stream index so a single socket can
// carry several cameras. Text frames are JSON control messages.

function startWebSocketServer(cb) {
  if (wss) { cb(null); return; }
  log('[WS] creating server on', WS_PORT);
  // Bind to loopback only — the stream is consumed by the local web app. Never
  // expose camera footage on the LAN.
  wss = new WebSocket.Server({ host: '127.0.0.1', port: WS_PORT });
  wss.once('listening', () => { log('[WS] listening on', WS_PORT); cb(null); });
  wss.once('error', (err) => { log('[WS] server error:', err.message); wss = null; cb(err); });
  // Bring late-joining clients up to speed on every active stream.
  wss.on('connection', (client) => {
    log('[WS] client connected');
    Object.keys(sessions).forEach((k) => sessions[k].replayTo(client));
  });
}

function sendBinary(streamIndex, buf) {
  if (!wss) return;
  (aliases[streamIndex] || [streamIndex]).forEach((index) => {
    const framed = Buffer.concat([Buffer.from([index & 0xff]), buf]);
    wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(framed, { binary: true }); });
  });
}

function sendText(str) {
  if (!wss) return;
  let m; try { m = JSON.parse(str); } catch (_) {}
  const indices = m && typeof m.stream === 'number' ? (aliases[m.stream] || [m.stream]) : [null];
  indices.forEach((index) => {
    const text = index === null ? str : JSON.stringify(Object.assign({}, m, { stream: index }));
    wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(text); });
  });
}

function sendTextTo(client, str) { if (client.readyState === WebSocket.OPEN) client.send(str); }
function sendBinaryTo(client, streamIndex, buf) {
  if (client.readyState === WebSocket.OPEN) client.send(Buffer.concat([Buffer.from([streamIndex & 0xff]), buf]), { binary: true });
}

// ─── A single camera: RTSP → depacketize → fMP4 → multiplexed WebSocket ──────

class Session {
  constructor(index, id, url) {
    this.index = index;
    this.id = id;
    this.url = url;
    this.muxer = null;
    this.sock = null;
    this.keepaliveTimer = null;
    this.initSegment = null;
    this.readyMsg = null;
    this.state = 'connecting'; // connecting | live | error | closed
    this.detail = '';
    // diagnostics
    this.rtp = 0;
    this.au = 0;
    this.bytes = 0;
    this.sock_s = '-';
  }

  setState(state, detail) {
    this.state = state;
    this.detail = detail || '';
    sendText(JSON.stringify({ type: 'streamstate', stream: this.index, id: this.id, state: state, detail: this.detail }));
  }

  replayTo(client) {
    (aliases[this.index] || [this.index]).forEach((index) => {
      if (this.readyMsg) { const m = JSON.parse(this.readyMsg); m.stream = index; sendTextTo(client, JSON.stringify(m)); }
      if (this.initSegment) sendBinaryTo(client, index, this.initSegment);
      sendTextTo(client, JSON.stringify({ type: 'streamstate', stream: index, id: this.id, state: this.state, detail: this.detail }));
    });
  }

  initMuxer() {
    this.muxer = new Mp4Muxer(
      (buf) => sendBinary(this.index, buf),
      (codec, mime, init) => {
        this.initSegment = init;
        this.readyMsg = JSON.stringify({ type: 'ready', stream: this.index, id: this.id, codec: codec, mime: mime });
        log('[mux] stream', this.index, 'init ready', codec);
        sendText(this.readyMsg);
        sendBinary(this.index, init);
      }
    );
  }

  start() {
    const parsed = parseRtspUrl(this.url);
    if (!parsed) { this.setState('error', 'bad url'); return; }
    this.initMuxer();
    this._connect(parsed);
  }

  _connect(parsed) {
    const self = this;
    const { host, port, path, auth } = parsed;
    let cseq = 1;
    let session = null;
    let sessionTimeout = 60;
    let state = 'OPTIONS';
    let buf = Buffer.alloc(0);
    let fuBuffer = null;
    let auNals = [];
    let auTs = null;

    const sock = net.createConnection({ host, port }, () => {
      log('[RTSP', self.index + '] connected', host, port);
      self.sock_s = 'connected';
      sendRequest('OPTIONS', `rtsp://${host}:${port}${path}`, {}, auth);
    });
    this.sock = sock;

    sock.on('data', (chunk) => { self.bytes += chunk.length; buf = Buffer.concat([buf, chunk]); buf = processBuffer(buf); });
    sock.on('error', (err) => { self.sock_s = 'error'; self.setState('error', err.message); log('[RTSP', self.index + '] error:', err.message); self._stopKeepalive(); });
    sock.on('close', () => { self.sock_s = 'closed'; if (self.state !== 'error') self.setState('closed', ''); log('[RTSP', self.index + '] closed'); self._stopKeepalive(); });
    sock.on('end', () => { self.sock_s = 'ended'; log('[RTSP', self.index + '] server FIN'); });

    function sendRequest(method, uri, extraHeaders, authHdr) {
      const headers = { CSeq: cseq++, 'User-Agent': 'TPlayer/1.0', ...extraHeaders };
      if (authHdr) headers.Authorization = authHdr;
      let req = `${method} ${uri} RTSP/1.0\r\n`;
      for (const [k, v] of Object.entries(headers)) req += `${k}: ${v}\r\n`;
      req += '\r\n';
      sock.write(req);
    }

    self._startKeepalive = function () {
      if (self.keepaliveTimer) clearInterval(self.keepaliveTimer);
      const interval = Math.max(10, Math.floor(sessionTimeout / 2)) * 1000;
      self.keepaliveTimer = setInterval(() => {
        if (sock.destroyed) { self._stopKeepalive(); return; }
        sendRequest('GET_PARAMETER', `rtsp://${host}:${port}${path}`, { Session: session }, auth);
      }, interval);
    };

    function processBuffer(data) {
      let offset = 0;
      while (offset < data.length) {
        if (data[offset] === 0x24) { // interleaved RTP: $ <ch> <len16> <payload>
          if (data.length - offset < 4) break;
          const channel = data[offset + 1];
          const rtpLen = data.readUInt16BE(offset + 2);
          if (data.length - offset - 4 < rtpLen) break;
          const rtpPacket = data.slice(offset + 4, offset + 4 + rtpLen);
          if (channel === 0) handleRtpPacket(rtpPacket);
          offset += 4 + rtpLen;
          continue;
        }
        const end = data.indexOf('\r\n\r\n', offset);
        if (end === -1) break;
        const headerBlock = data.slice(offset, end).toString('ascii');
        const bodyOffset = end + 4;
        const contentLength = parseContentLength(headerBlock);
        if (data.length - bodyOffset < contentLength) break;
        const body = data.slice(bodyOffset, bodyOffset + contentLength).toString('utf8');
        handleRtspResponse(headerBlock, body);
        offset = bodyOffset + contentLength;
      }
      return data.slice(offset);
    }

    function parseContentLength(headers) { const m = headers.match(/Content-Length:\s*(\d+)/i); return m ? parseInt(m[1], 10) : 0; }

    function handleRtspResponse(headers, body) {
      const firstLine = headers.split('\r\n')[0];
      const statusCode = parseInt(firstLine.split(' ')[1], 10);
      if (statusCode === 401) { self.setState('error', 'auth required'); return; }
      if (statusCode !== 200) { self.setState('error', firstLine); return; }

      const sm = headers.match(/Session:\s*([^;\r\n]+)/i);
      if (sm && !session) session = sm[1].trim();
      const tm = headers.match(/Session:[^\r\n]*timeout=(\d+)/i);
      if (tm) sessionTimeout = parseInt(tm[1], 10);

      switch (state) {
        case 'OPTIONS':
          state = 'DESCRIBE';
          sendRequest('DESCRIBE', `rtsp://${host}:${port}${path}`, { Accept: 'application/sdp' }, auth);
          break;
        case 'DESCRIBE': {
          state = 'SETUP';
          const controlUrl = extractControlUrl(body, `rtsp://${host}:${port}${path}`);
          sendRequest('SETUP', controlUrl, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' }, auth);
          break;
        }
        case 'SETUP':
          state = 'PLAY';
          sendRequest('PLAY', `rtsp://${host}:${port}${path}`, { Session: session, Range: 'npt=0.000-' }, auth);
          break;
        case 'PLAY':
          state = 'STREAMING';
          log('[RTSP', self.index + '] streaming, timeout', sessionTimeout + 's');
          self.setState('live', '');
          self._startKeepalive();
          break;
      }
    }

    function handleRtpPacket(packet) {
      self.rtp++;
      if (packet.length < 13) return;
      const cc = packet[0] & 0x0f;
      const rtpHeaderLen = 12 + cc * 4;
      if (packet.length <= rtpHeaderLen) return;
      const marker = (packet[1] & 0x80) !== 0;
      const timestamp = packet.readUInt32BE(4);
      const payload = packet.slice(rtpHeaderLen);
      const nalType = payload[0] & 0x1f;

      if (nalType >= 1 && nalType <= 23) {
        addNal(payload, timestamp);
      } else if (nalType === 24) {
        let off = 1;
        while (off + 2 <= payload.length) {
          const size = payload.readUInt16BE(off); off += 2;
          if (off + size > payload.length) break;
          addNal(payload.slice(off, off + size), timestamp); off += size;
        }
      } else if (nalType === 28) {
        if (payload.length < 2) return;
        const fu = payload[1];
        const isStart = (fu & 0x80) !== 0, isEnd = (fu & 0x40) !== 0, fragType = fu & 0x1f;
        if (isStart) { const nalHeader = (payload[0] & 0xe0) | fragType; fuBuffer = [Buffer.from([nalHeader]), payload.slice(2)]; }
        else if (fuBuffer) fuBuffer.push(payload.slice(2));
        if (isEnd && fuBuffer) { addNal(Buffer.concat(fuBuffer), timestamp); fuBuffer = null; }
      }
      if (marker) flushAccessUnit();
    }

    function addNal(nal, ts) { if (auTs !== null && ts !== auTs) flushAccessUnit(); auTs = ts; auNals.push(nal); }
    function flushAccessUnit() {
      if (auNals.length === 0) return;
      try { if (self.muxer) { self.muxer.pushAccessUnit(auNals, auTs); self.au++; } }
      catch (e) { log('[mux', self.index + '] error:', e.message); }
      auNals = []; auTs = null;
    }
  }

  _stopKeepalive() { if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; } }

  destroy() {
    this._stopKeepalive();
    if (this.sock) { try { this.sock.destroy(); } catch (e) { /* ignore */ } this.sock = null; }
    this.muxer = null;
    this.initSegment = null;
    this.readyMsg = null;
  }
}

// ─── Luna service methods ────────────────────────────────────────────────────

// start: open the WebSocket and hold a subscription lifeline so webOS does not
// reap the service. Streams are configured separately so the app can switch the
// active stream without tearing down the whole pipeline.
service.register('start', (msg) => {
  log('[Luna] start (subscribed:', !!msg.isSubscription, ')');
  streamSub = msg; // lifeline — never completed
  startWebSocketServer((err) => {
    if (err) { msg.respond({ returnValue: false, errorText: 'WS server failed: ' + err.message }); return; }
    if (msg.payload && (msg.payload.cameras || msg.payload.url)) {
      applyConfig(msg.payload.cameras || [{ id: 'cam', url: msg.payload.url, stream: 0 }]);
    }
    if (!diagTimer) startDiag();
    msg.respond({ returnValue: true, wsPort: WS_PORT, subscribed: !!msg.isSubscription });
  });
});

// configure: set the desired camera set ({cameras:[{id,url,stream},...]}). Diffs
// against running sessions — keeps unchanged ones, starts new, stops removed.
service.register('configure', (msg) => {
  const cams = msg.payload.cameras || [];
  log('[Luna] configure', cams.length, 'stream(s)');
  teardownSessions();
  applyConfig(cams);
  if (!diagTimer) startDiag();
  msg.respond({ returnValue: true, streams: cams.length });
});

service.register('stop', (msg) => { teardownAll(); msg.respond({ returnValue: true }); });

function applyConfig(cams) {
  const byUrl = new Map();
  aliases = {};
  (cams || []).forEach((c, i) => {
    if (!c || !c.url) return;
    const idx = (c.stream != null ? c.stream : i) & 0xff;
    if (byUrl.has(c.url)) { aliases[byUrl.get(c.url)].push(idx); return; }
    byUrl.set(c.url, idx);
    aliases[idx] = [idx];
    sessions[idx] = new Session(idx, String(c.id || ('cam' + idx)), c.url);
  });
  Object.keys(sessions).forEach((k) => sessions[k].start());
}

// ─── Diagnostics (lightweight; for the app's optional debug overlay) ─────────

function startDiag() {
  if (diagTimer) clearInterval(diagTimer);
  let tick = 0;
  diagTimer = setInterval(() => {
    tick++;
    sendText(JSON.stringify({
      type: 'diag', tick: tick,
      streams: Object.keys(sessions).map((k) => { const s = sessions[k]; return { i: s.index, st: s.state, rtp: s.rtp, au: s.au, sock: s.sock_s }; }),
    }));
  }, 1000);
}

// ─── Teardown ────────────────────────────────────────────────────────────────

function teardownSessions() {
  Object.keys(sessions).forEach((k) => sessions[k].destroy());
  sessions = {};
}

function teardownAll() {
  teardownSessions();
  if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
  if (wss) { wss.close(); wss = null; }
  if (streamSub) { try { streamSub.cancel(); } catch (e) { /* ignore */ } streamSub = null; }
  log('[TPlayer] torn down');
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function parseRtspUrl(url) {
  const m = url.match(/^rtsp:\/\/(?:([^/]+)@)?([^/:]+)(?::(\d+))?(\/.*)?$/i);
  if (!m) return null;
  return {
    auth: m[1] ? `Basic ${Buffer.from(m[1].split(':').map(x => decodeURIComponent(x)).join(':')).toString('base64')}` : null,
    host: m[2],
    port: m[3] ? parseInt(m[3], 10) : 554,
    path: m[4] || '/',
  };
}

function extractControlUrl(sdp, base) {
  const videoSection = sdp.match(/m=video[\s\S]*?(?=m=|$)/);
  if (videoSection) {
    const ctrl = videoSection[0].match(/a=control:(.+)/);
    if (ctrl) { const u = ctrl[1].trim(); return u.startsWith('rtsp://') ? u : `${base}/${u}`; }
  }
  const sessionCtrl = sdp.match(/a=control:(.+)/);
  if (sessionCtrl) { const u = sessionCtrl[1].trim(); return u.startsWith('rtsp://') ? u : `${base}/${u}`; }
  return base;
}

