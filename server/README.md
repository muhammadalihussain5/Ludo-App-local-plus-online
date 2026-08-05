# 🎲 Ludo Online Server

## Setup

```bash
cd server
npm install
npm start
```

The server will start on port 3001 by default. You can change this by setting the `PORT` environment variable:

```bash
PORT=8080 npm start
```

## How to Play Online

1. Start the server using the commands above
2. Open the Ludo app in your browser
3. Click "Online Play"
4. Enter the server URL (default: `http://localhost:3001`)
5. Enter your username and click "Connect & Login"
6. In the lobby, create a room or wait for an invite
7. Invite other players by their username
8. Once all players have joined, the host clicks "Start Game!"

## Features

- Real-time multiplayer via WebSockets
- Server-authoritative dice rolls (anti-cheat)
- Room-based game sessions
- Player invitation system
- Automatic reconnection support
