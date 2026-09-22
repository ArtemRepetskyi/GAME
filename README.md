# Operation Safe Return

A browser-based first-person hostage-rescue game with a paper-and-ink look. Find the hostage and escape together. Built with TypeScript, Three.js, Preact, and Vite.

```sh
npm install
npm run dev
```

Open the local Vite URL and select **Begin mission**. Controls are in the game menu. The character lab is at `/lab.html`.

- `npm run build` — type-check and build for production.
- `npm test` — run all logic checks.

[MIT](LICENSE) covers the source code. Audio has separate terms; Project I.G.I. recordings are not licensed for reuse here. See [sound credits](public/sounds/CREDITS.md).

## Online co-op

Open the menu → **Online**, pick a mode, **Create room**, then send friends the room code or the invite link (**Copy invite link**). They open the link (or enter the code) and press **Join**.

- Networking is peer-to-peer WebRTC via [PeerJS](https://peerjs.com). The site stays static (it runs on GitHub Pages); the free public PeerJS server is only used so players can find each other. The room creator is the host and relays everything, so keep the host tab open.
- **Together vs guards** (co-op): teammates appear as green stickmen with their names; you see and hear their shots. A guard killed by anyone dies for everyone. There is no friendly fire.
- **1 vs 1 duel**: guards are removed and their guns lie where they stood; the opponent is orange and bullets hurt. Each death scores a kill for the shooter (shown in the room list); press **Try again** to respawn at a post far from the others.
- Right-click aiming zooms the view slightly (1.35×) with every weapon; the sniper keeps its scope.
- Each player still runs their own copy of the mission: guard movement, the hostage, doors, alarms and mission progress are **not** synchronised.
- Some strict networks (symmetric NAT, corporate firewalls) block direct WebRTC connections; without a TURN server those players cannot connect.
- To use your own PeerJS server instead of the public one, add `?peer=https://your-host:port` to the page URL (run one with `npx peerjs --port 9000`).

## GitHub Pages

`.github/workflows/pages.yml` builds the game on every push and publishes the default branch to GitHub Pages. One-time setup: repository **Settings → Pages → Build and deployment → Source: GitHub Actions**, then re-run the workflow (Actions tab → *Deploy to GitHub Pages* → *Re-run jobs*).

## Working with coding agents

[AGENTS.md](AGENTS.md) contains the shared project instructions, structure, and testing guide. The [browser-check workflow](.agent/skills/browser-check/SKILL.md) covers visual verification of the game and character lab.

`.agent/` holds repository workflow notes; automatic discovery depends on the coding tool. `CLAUDE.md` imports the shared instructions for compatibility. Keep machine-local settings out of Git and save generated screenshots, recordings, and test evidence in the ignored `artifacts/` directory.

## Gameplay

https://github.com/user-attachments/assets/d397e167-213b-419d-9b45-5d0fcb534e4e



https://github.com/user-attachments/assets/72868325-db6f-4837-80ec-334a9c56af82








