# EchoRoom Group Voice Chat

A simple group voice chat website built with WebRTC + Socket.IO signaling.

## Features

- Join any room by ID
- Real-time multi-user voice chat
- Mute/unmute controls
- Discord-style deafen control (mute incoming audio + mute your mic)
- Screen sharing in voice rooms
- Live participant status (live/muted)
- Responsive UI for desktop and mobile

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Create local env file from `.env.example` (optional but recommended):

```bash
copy .env.example .env
```

3. Start the server:

```bash
npm start
```

4. Open in your browser:

- `http://localhost:3000`

## How To Test

- Open two or more browser tabs/windows.
- Enter the same room ID in each tab.
- Allow microphone permission.
- Speak in one tab and listen from the others.

## Git Fix: Remove node_modules From Tracking

If `node_modules` was pushed before, run this once:

```bash
git rm -r --cached node_modules
git add .gitignore
git commit -m "Stop tracking node_modules"
git push
```

`.gitignore` already includes `node_modules/` in this project now.

## Deploy Backend To Render

1. Push repository to GitHub.
2. In Render, create a new Web Service from this repo.
3. Render detects `render.yaml` and uses:

- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`

4. Set `CORS_ORIGIN` to your Vercel domain, for example:

```text
https://your-vercel-project.vercel.app
```

5. Set keep-alive env vars in Render (already present in `render.yaml`):

```text
KEEP_ALIVE_ENABLED=true
KEEP_ALIVE_INTERVAL_MS=840000
KEEP_ALIVE_URL=https://your-render-service.onrender.com/health
```

6. Deploy and copy the Render URL, for example:

```text
https://your-render-service.onrender.com
```

7. Optional but recommended: add an external uptime monitor (for example UptimeRobot or cron-job.org) that pings `/health` every 5 to 10 minutes.

## Deploy Frontend To Vercel

1. Import the same repo in Vercel.
2. Deploy using default settings (the included `vercel.json` rewrites to `public`).
3. In Vercel project settings, add env var:

```text
SIGNAL_SERVER_URL=https://your-render-service.onrender.com
```

4. Redeploy (or trigger a new deployment).
5. Open the deployed site. The app auto-loads backend URL from `/api/socket-url`.
6. Optional override: paste a different URL into `Signal Server URL (optional)`.

Tip: you can leave the server field blank for local same-origin usage.

## Notes

- This app uses a mesh WebRTC topology, which is good for small groups.
- For large rooms, use an SFU media server architecture for better performance.
