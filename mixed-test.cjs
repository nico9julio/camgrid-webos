// Temporary local-only experiment; configuration is read into memory only.
const http = require('http');
const cp = require('child_process');
const WS = require('/media/developer/apps/usr/palm/services/com.camgrid.app.service/node_modules/ws');
let control, gst, server, stopping = false, frameCount = 0;
function finish() {
  if (stopping) return; stopping = true;
  if (gst) gst.kill('SIGTERM');
  if (server) server.close();
  if (control && control.readyState === WS.OPEN) {
    control.send(JSON.stringify({ id: 9, method: 'Page.reload', params: { ignoreCache: true } }));
    setTimeout(() => process.exit(0), 500);
  } else process.exit(0);
}
process.on('SIGTERM', finish); process.on('SIGINT', finish);
http.get('http://127.0.0.1:9998/json', res => {
  let data = ''; res.on('data', b => data += b); res.on('end', () => {
    let page = JSON.parse(data).find(x => x.description === 'com.camgrid.app');
    if (!page) { console.log('CamGrid no está abierta'); return finish(); }
    control = new WS(page.webSocketDebuggerUrl);
    control.on('open', () => control.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(config.cameras.slice(0,2))', returnByValue: true } })));
    control.on('message', raw => {
      const msg = JSON.parse(raw); if (msg.id !== 1) return;
      let cams; try { cams = JSON.parse(msg.result.result.value); } catch (_) { console.log('No se pudo leer la configuración'); return finish(); }
      if (!cams[0] || !cams[1]) { console.log('Faltan cámaras configuradas'); return finish(); }
      server = new WS.Server({ host: '127.0.0.1', port: 9878 });
      server.on('listening', () => {
        const expression = `(()=>{view=2;layout();generation++;stopSlot(slots[0]);status(0,'Conectando�');webOS.service.request(SVC,{method:'configure',parameters:{cameras:[{id:'camera0',url:config.cameras[0],stream:0}]}});let s=slots[1];stopSlot(s);s.primary=1;s.video.hidden=true;s.canvas.hidden=false;status(1,'Prueba de software: conectando');let w=new WebSocket('ws://127.0.0.1:9878');window.__mixedTest=w;w.binaryType='arraybuffer';w.onmessage=e=>{try{let d=new Uint8ClampedArray(e.data);if(d.length!==320*180*4)return;s.canvas.getContext('2d').putImageData(new ImageData(d,320,180),0,0);status(1,'Prueba de software')}catch(_){status(1,'Error al dibujar')}};w.onclose=()=>status(1,'Prueba finalizada');return 'ok'})()`;
        control.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        // Substream saves CPU where the camera supports it. No data is logged.
        const url = cams[1].replace(/\/stream1(?=\?|$)/i, '/stream2');
        const args = ['-q', 'rtspsrc', 'location=' + url, 'protocols=tcp', 'latency=100', '!', 'rtph264depay', '!', 'h264parse', '!', 'avdec_h264', 'max-threads=2', '!', 'videoscale', '!', 'videoconvert', '!', 'video/x-raw,format=RGBA,width=320,height=180', '!', 'fdsink', 'fd=1', 'sync=false'];
        gst = cp.spawn('gst-launch-1.0', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        const size = 320 * 180 * 4; let pending = Buffer.alloc(0);
        gst.stdout.on('data', chunk => {
          pending = Buffer.concat([pending, chunk]);
          while (pending.length >= size) {
            let frame = pending.subarray(0, size); pending = pending.subarray(size); frameCount++;
            server.clients.forEach(c => { if (c.readyState === WS.OPEN && c.bufferedAmount < size * 2) c.send(frame, { binary: true }); });
          }
        });
        gst.on('error', () => console.log('No se pudo iniciar el decodificador'));
        console.log('Prueba activa; se restaurará la aplicación automáticamente');
        setTimeout(() => { console.log('Fotogramas por software:', frameCount); finish(); }, 90000);
      });
      server.on('error', () => { console.log('No se pudo abrir la conexión local de prueba'); finish(); });
    });
    control.on('error', () => { console.log('No se pudo conectar al panel de diagnóstico'); finish(); });
  });
}).on('error', () => { console.log('No se pudo localizar CamGrid'); finish(); });
