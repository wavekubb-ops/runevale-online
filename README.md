# Runevale Online

A small browser-based multiplayer MMORPG prototype designed to be manageable from an iPhone.

## Features
- Shared real-time map using Socket.IO
- Multiple zones: Prontera, Prontera Field, Payon Forest, Morroc Desert
- Player presence and movement
- Zone chat
- Click-to-move and tap-to-attack
- Simple Poring and Lunatic combat with prototype level-ups
- Mobile-friendly interface

## Run locally
```sh
npm install
npm start
``
Open http://localhost:3000.

## Deploy
This project includes `render.yaml` for Render. Connect this GitHub repository to Render and create a Web Service. Render will use the build and start commands in the blueprint.

## Prototype limitations
This is an early multiplayer prototype, not a production MMORPG. Character data is currently in server memory and resets when the server restarts. It does not yet include persistent accounts, secure authentication, party/guild persistence, trading, anti-cheat, or production database storage. Free hosting may sleep when idle.
