import * as THREE from 'three'
import { NetworkSession, normalizeCode, type GameMode, type NetMessage, type PlayerState } from './network'
import { RemotePlayers } from './remote-players'
import type { Vec3, WeaponName } from './types'

type OnlineHooks = {
  /** A teammate fired; `end` is where their bullet stopped in their copy of the world. */
  shot: (from: string, origin: THREE.Vector3, end: THREE.Vector3, weapon?: WeaponName, pellet?: boolean) => void
  kill: (enemy: string, direction: THREE.Vector3) => void
  notify: (text: string) => void
  /** Room mode changed (joined, created, or left: back to 'coop' single player). */
  mode: (mode: GameMode) => void
  /** Another player shot us in a duel. Returns true when that hit was lethal. */
  hurt: (damage: number, source: THREE.Vector3) => boolean
}

const SEND_INTERVAL = 1 / 15
const tuple = (vector: THREE.Vector3): Vec3 => [+vector.x.toFixed(3), +vector.y.toFixed(3), +vector.z.toFixed(3)]

/** The Online menu page plus the glue between the mission runtime and the network session. */
export class OnlinePlay {
  readonly remote: RemotePlayers
  private session: NetworkSession | null = null
  private sendTimer = 0
  private lastSent = ''
  private abort = new AbortController()
  private root: HTMLElement
  private status: HTMLElement
  private roster: HTMLElement
  private share: HTMLElement
  private nameInput: HTMLInputElement
  private codeInput: HTMLInputElement
  private createButton: HTMLButtonElement
  private joinButton: HTMLButtonElement
  private leaveButton: HTMLButtonElement
  private modeInputs: HTMLInputElement[]
  private modeNote: HTMLElement
  mode: GameMode = 'coop'
  private frags = new Map<string, number>()
  private lastRoster: { id: string; name: string }[] = []

  constructor(scene: THREE.Scene, private invalidate: () => void, private hooks: OnlineHooks) {
    this.remote = new RemotePlayers(scene, invalidate)
    this.root = document.querySelector<HTMLElement>('.mission-online-slot') ?? document.createElement('div')
    const storedName = (() => { try { return localStorage.getItem('operation-ink-name') ?? '' } catch { return '' } })()
    const params = new URLSearchParams(location.search)
    this.root.innerHTML = `
      <div class="online-form">
        <label>Your name <input id="online-name" maxlength="20" autocomplete="nickname" placeholder="Player" /></label>
        <fieldset class="online-mode">
          <legend>Mode (the room creator can change it at any time)</legend>
          <label><input type="radio" name="online-mode" value="coop" checked /> Together vs guards</label>
          <label><input type="radio" name="online-mode" value="versus" /> 1 vs 1 duel (no guards)</label>
        </fieldset>
        <div class="online-row">
          <button id="online-create" class="menu-secondary">Create room</button>
        </div>
        <div class="online-row">
          <input id="online-code" maxlength="12" placeholder="Room code" autocapitalize="characters" spellcheck="false" aria-label="Room code" />
          <button id="online-join" class="menu-secondary">Join</button>
        </div>
        <div id="online-share" hidden></div>
        <p id="online-mode-note" hidden></p>
        <p id="online-status" role="status">Not connected.</p>
        <ul id="online-roster" aria-label="Players in the room"></ul>
        <button id="online-leave" class="menu-quiet" hidden>Leave room</button>
      </div>`
    const q = <T extends HTMLElement>(selector: string) => this.root.querySelector<T>(selector)!
    this.status = q('#online-status'); this.roster = q('#online-roster'); this.share = q('#online-share')
    this.nameInput = q('#online-name'); this.codeInput = q('#online-code')
    this.createButton = q('#online-create'); this.joinButton = q('#online-join'); this.leaveButton = q('#online-leave')
    this.modeInputs = [...this.root.querySelectorAll<HTMLInputElement>('input[name="online-mode"]')]
    this.modeNote = q('#online-mode-note')
    this.nameInput.value = storedName
    this.codeInput.value = normalizeCode(params.get('room') ?? '')
    const options = { signal: this.abort.signal }
    this.createButton.addEventListener('click', () => void this.start(null), options)
    this.joinButton.addEventListener('click', () => void this.start(normalizeCode(this.codeInput.value)), options)
    this.codeInput.addEventListener('keydown', event => { if (event.key === 'Enter') this.joinButton.click() }, options)
    this.leaveButton.addEventListener('click', () => this.leave(), options)
    for (const input of this.modeInputs) input.addEventListener('change', () => {
      if (input.checked && this.session?.host) this.session.setMode(input.value === 'versus' ? 'versus' : 'coop')
    }, options)
    window.addEventListener('pagehide', () => this.session?.close(), options)
    if (this.codeInput.value) {
      this.status.textContent = `Invitation to room ${this.codeInput.value}: enter your name and press Join.`
      // Fetch the networking code while the player reads the menu.
      void import('peerjs').catch(() => {})
    }
  }

  get connected() { return Boolean(this.session?.connected) }

  private playerName() {
    const name = this.nameInput.value.trim().slice(0, 20) || 'Player'
    try { localStorage.setItem('operation-ink-name', name) } catch { /* private mode */ }
    return name
  }

  private setBusy(busy: boolean) {
    this.createButton.disabled = this.joinButton.disabled = busy || Boolean(this.session)
    // Only the host decides the mode once a room exists.
    for (const input of this.modeInputs) input.disabled = Boolean(this.session) && !this.session?.host
    this.leaveButton.hidden = !this.session
  }

  private async start(code: string | null) {
    if (this.session) return
    if (code === '') { this.status.textContent = 'Enter the room code first.'; this.codeInput.focus(); return }
    const session = new NetworkSession({
      message: (from, message) => this.receive(from, message),
      leave: id => this.remote.remove(id),
      status: text => { this.status.textContent = text; this.hooks.notify(text) },
      roster: (players, mode) => { this.lastRoster = players; this.setMode(mode); this.showRoster(players); this.invalidate() },
    }, this.playerName())
    this.session = session
    this.setBusy(true)
    this.status.textContent = code ? `Connecting to room ${code}…` : 'Opening a room…'
    try {
      if (code) await session.join(code)
      else await session.create(this.modeInputs.find(input => input.checked)?.value === 'versus' ? 'versus' : 'coop')
      if (this.session !== session) return
      const link = new URL(location.href)
      const broker = link.searchParams.get('peer')
      link.search = ''
      if (broker) link.searchParams.set('peer', broker)
      link.searchParams.set('room', session.code)
      this.share.hidden = false
      this.share.innerHTML = `<span>Room code</span><strong>${session.code}</strong><button class="menu-quiet" id="online-copy">Copy invite link</button>`
      this.share.querySelector('#online-copy')!.addEventListener('click', () => {
        void navigator.clipboard?.writeText(link.toString()).then(() => { this.status.textContent = 'Invite link copied.' }, () => { this.status.textContent = link.toString() })
      }, { signal: this.abort.signal })
      this.lastSent = ''
      this.invalidate()
    } catch (error) {
      if (this.session !== session) return
      session.close()
      this.session = null
      this.status.textContent = `Could not connect: ${error instanceof Error ? error.message : String(error)}`
    }
    this.setBusy(false)
  }

  leave() {
    this.session?.close()
    this.session = null
    this.remote.clear()
    this.share.hidden = true
    this.status.textContent = 'Not connected.'
    this.frags.clear()
    this.showRoster([])
    this.setMode('coop')
    this.setBusy(false)
  }

  private setMode(mode: GameMode) {
    if (mode === this.mode) return
    this.mode = mode
    this.remote.hostile = mode === 'versus'
    for (const input of this.modeInputs) input.checked = input.value === mode
    this.modeNote.hidden = mode !== 'versus'
    this.modeNote.textContent = 'Duel: guards are gone, their guns lie where they stood. Shoot the orange player. After dying press Try again to respawn.'
    this.hooks.mode(mode)
    if (this.session) this.hooks.notify(mode === 'versus' ? 'Mode: 1 vs 1 duel.' : 'Mode: together vs guards.')
  }

  private showRoster(players: { id: string; name: string }[]) {
    this.roster.replaceChildren(...players.map(player => {
      const item = document.createElement('li')
      const you = player.id === this.session?.id ? ' (you)' : ''
      item.textContent = this.mode === 'versus' ? `${player.name}${you} — ${this.frags.get(player.id) ?? 0} kills` : `${player.name}${you}`
      return item
    }))
  }

  private receive(from: string, message: NetMessage) {
    const session = this.session
    if (!session) return
    switch (message.t) {
      case 'state': this.remote.apply(from, session.nameOf(from), message.s); break
      case 'shot': {
        if (!message.pellet) this.remote.shoot(from)
        const origin = this.remote.muzzle(from) ?? new THREE.Vector3(...message.o)
        this.hooks.shot(from, origin, new THREE.Vector3(...message.e), message.weapon, Boolean(message.pellet))
        break
      }
      case 'kill': this.hooks.kill(String(message.enemy), new THREE.Vector3(...message.d)); break
      case 'hit': {
        if (this.mode !== 'versus' || message.target !== session.id) break
        const damage = Math.min(200, Math.max(0, Number(message.damage) || 0))
        if (this.hooks.hurt(damage, new THREE.Vector3(...message.o))) {
          session.send({ t: 'frag', killer: from })
          this.scored(from, session.id)
        }
        break
      }
      case 'frag': this.scored(String(message.killer), from); break
    }
  }

  /** Called every frame. Sends our own state at a fixed rate and animates teammates. */
  update(dt: number, state: PlayerState) {
    const session = this.session
    if (session?.connected) {
      this.sendTimer -= dt
      const encoded = JSON.stringify(state)
      // Standing still sends one update a second so newcomers still learn where we are.
      if (this.sendTimer <= 0 && (encoded !== this.lastSent || this.sendTimer < -1)) {
        this.sendTimer = SEND_INTERVAL
        this.lastSent = encoded
        session.send({ t: 'state', s: state })
      }
    }
    // Keep frames (and therefore state updates) flowing while in a room, even from the menu.
    return this.remote.update(dt) || Boolean(session?.connected)
  }

  shot(origin: THREE.Vector3, end: THREE.Vector3, weapon?: WeaponName, pellet = false) {
    this.session?.send({ t: 'shot', o: tuple(origin), e: tuple(end), weapon, ...(pellet ? { pellet } : {}) })
  }

  private scored(killer: string, victim: string) {
    const session = this.session
    if (!session) return
    this.frags.set(killer, (this.frags.get(killer) ?? 0) + 1)
    const name = (id: string) => id === session.id ? 'You' : session.nameOf(id)
    this.hooks.notify(`${name(killer)} killed ${victim === session.id ? 'you' : session.nameOf(victim)}.`)
    this.showRoster(this.lastRoster)
  }

  /** Duel only: did our bullet segment hit another player? Sends the damage to them. */
  hitPlayer(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, damage: (zone: import('./hit-reactions').HitZone, distance: number) => number) {
    if (this.mode !== 'versus' || !this.session) return null
    const hit = this.remote.hitTest(origin, direction, maxDistance)
    if (!hit) return null
    this.session.send({ t: 'hit', target: hit.id, damage: +damage(hit.zone, hit.distance).toFixed(1), o: tuple(origin) })
    return hit
  }

  kill(enemy: string, direction: THREE.Vector3) {
    this.session?.send({ t: 'kill', enemy, d: tuple(direction) })
  }

  static stateOf(position: THREE.Vector3, yaw: number, weapon: WeaponName | null, dead: boolean): PlayerState {
    return { p: tuple(position), yaw: +yaw.toFixed(3), weapon, dead }
  }

  dispose() { this.abort.abort(); this.session?.close(); this.session = null; this.remote.dispose() }
}
