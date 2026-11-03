# CamGrid for LG webOS

CamGrid is a rooted LG webOS application for viewing up to four H.264 RTSP
camera streams. It supports optional camera slots, selectable one-to-four
camera layouts, and a user-selected default layout.

## Layout

- `index.html`: TV interface and camera grid.
- `js/app.js`: layout, settings, local persistence, and video playback.
- `services/com.camgrid.app.service/`: local webOS service that connects to
  RTSP cameras and forwards fragmented MP4 data to the app.
- `appinfo.json`: webOS application manifest.
- `mixed-test.cjs`: temporary diagnostic experiment for hardware/software
  playback; it is not part of the normal runtime.
- `verify-aliases.cjs`: service-level regression check for duplicated camera
  outputs.
- `camgrid-dist/`: local build output. Packages are intentionally ignored by
  Git.

## Development

Install the service dependency from its directory:

```powershell
npm ci --omit=dev
```

Build an IPK with webOS OSE `ares-package` by staging the app files and the
service directory. Keep the generated IPK outside version control.

## Camera credentials

Camera URLs, usernames, and passwords are entered on the TV and stored in the
TV app's local storage. Do not commit them, paste them into source files, or
put them in issue reports. The repository contains no camera configuration.

## Current limitations

The webOS TV tested here may not advance multiple native video decoders at the
same time. A hardware path plus a software path can run concurrently, but the
software path may show incomplete or incorrectly coloured frames depending on
the camera stream.

