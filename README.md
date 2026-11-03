# CamGrid for LG webOS

CamGrid is a rooted LG webOS application for viewing up to four H.264 RTSP camera streams. It plays one camera at a time, full screen, and uses the TV's native video element. Remote buttons 1–4 switch cameras; the direction buttons temporarily reveal the camera name and Settings button, which fade after three seconds.

## Project files

- `index.html`: full-screen TV interface and settings panel.
- `js/app.js`: camera selection, playback, remote control, and local settings storage.
- `services/com.camgrid.app.service/`: webOS service that connects to RTSP cameras and forwards fragmented MP4 data to the app. It keeps at most one camera session active.
- `appinfo.json`: webOS application manifest.
- `mixed-test.cjs`: diagnostic experiment; it is not part of normal playback.
- `camgrid-dist/`: local package output, excluded from Git.

## Build

Install the service dependencies from its directory:

```powershell
cd services/com.camgrid.app.service
npm ci --omit=dev
```

Use webOS OSE `ares-package` to package the app files together with the service directory. Stage the app files (`appinfo.json`, `index.html`, icons, and `js/`) and keep the generated IPK in `camgrid-dist/`.

## Camera settings and privacy

Enter camera RTSP URLs in the app on the TV. The app stores them in that TV's local storage. Do not add camera URLs, usernames, passwords, or other credentials to this repository. The repository contains no camera configuration.

## Playback note

CamGrid sends the H.264 stream through MediaSource to the TV's native video element and does not decode video in application JavaScript. Hardware decoding depends on the TV model and stream format.
