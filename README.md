# Traditional Ludo

A modern Ludo game built with React, Vite, TypeScript, Tailwind CSS, and Socket.IO. The app supports local play, pass-and-play, AI opponents, and online multiplayer through the bundled Node.js server.

## Features

- Local play against AI or in pass-and-play mode
- Online multiplayer with room-based lobbies
- Server-side game flow for online matches
- Configurable dice rules and bonus-turn options
- Single-page Vite client with a separate Express + Socket.IO server

## Requirements

- Node.js 18 or newer
- npm

## Setup

Install dependencies for the client and server:

```bash
npm install
cd server
npm install
```

## Run Locally

Start the client in one terminal:

```bash
npm run dev
```

Start the online server in another terminal:

```bash
cd server
npm start
```

The server runs on port `3001` by default. Set `PORT` if you want to use a different port.

## Build

Create a production client build with:

```bash
npm run build
```

The server automatically serves the built client from `dist/` when it is available.

## Project Structure

- `src/` - React app, game UI, and game logic
- `server/` - Express and Socket.IO multiplayer server
- `index.html` - Vite entry point
- `vite.config.ts` - Vite configuration

## Online Play

1. Start the server with `npm start` inside `server/`
2. Open the client in your browser
3. Choose Online Play
4. Connect to the server URL shown in the login screen
5. Create or join a room and start the match
