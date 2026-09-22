import * as THREE from 'three'
import { NetworkSession, normalizeCode, type NetMessage, type PlayerState } from './network'
import { RemotePlayers } from './remote-players'
import type { Vec3, WeaponName } from './types'

type OnlineHooks = {
  /** A teammate fired; `end` is where their bullet stopped in their copy of the world. */
  shot: (from: string, origin: THREE.Vector3, end: THREE.Vector3, weapon?: WeaponName, pellet?: boolean) => void
  kill: (enemy: string, direction: THREE.Vector3) => void
  notify: (text: string) => void
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

  constructor(scene: THREE.Scene, private invalidate: () => void, private hooks: OnlineHooks) {
    this.remote = new RemotePlayers(scene, invalidate)
    this.root = document.querySelector<HTMLElement>('.mission-online-slot') ?? document.createElement('div')
    const storedName = (() => { try { return localStorage.getItem('operation-ink-name') ?? '' } catch { return '' } })()
    const params = new URLSearchParams(location.search)
    this.root.innerHTML = `
      <div class="online-form">
        <label>Your name <input id="online-name" maxlength="20" autocomplete="nickname" placeholder="Player" /></label>
        <div class="online-row">
          <button id="online-create" class="menu-secondary">Create room</button>
        </div>
        <div class="online-row">
          <input id="online-code" maxlength="12" placeholder="Room code" autocapitalize="characters" spellcheck="false" aria-label="Room code" />
          <button id="online-join" class="menu-secondary">Join</button>
        </div>
        <div id="online-share" hidden></div>
        <p id="online-status" role="status">Not connected.</p>
        <ul id="online-roster" aria-label="Players in the room"></ul>
        <button id="online-leave" class="menu-quiet" hidden>Leave room</button>
      </div>`
    const q = <T extends HTMLElement>(selector: string) => this.root.querySelector<T>(selector)!
    this.status = q('#online-status'); this.roster = q('#online-roster'); this.share = q('#online-share')
    this.nameInput = q('#online-name'); this.codeInput = q('#online-code')
    this.createButton = q('#online-create'); this.joinButton = q('#online-join'); this.leaveButton = q('#online-leave')
    this.nameInput.value = storedName
    this.codeInput.value = normalizeCode(params.get('room') ?? '')
    const options = { signal: this.abort.signal }
    this.createButton.addEventListener('click', () => void this.start(null), options)
    this.joinButton.addEventListener('click', () => void this.start(normalizeCode(this.codeInput.value)), options)
    this.codeInput.addEventListener('keydown', event => { if (event.key === 'Enter') this.joinButton.click() }, options)
    this.leaveButton.addEventListener('click', () => this.leave(), options)
    window.addEventListener('pagehide', () => this.session?.close(), options)
    if (this.codeInput.value) this.status.textContent = `Invitation to room ${this.codeInput.value}: enter your name and press Join.`
  }

  get connected() { return Boolean(this.session?.connected) }

  private playerName() {
    const name = this.nameInput.value.trim().slice(0, 20) || 'Player'
    try { localStorage.setItem('operation-ink-name', name) } catch { /* private mode */ }
    return name
  }

  private setBusy(busy: boolean) {
    this.createButton.disabled = this.joinButton.disabled = busy || Boolean(this.session)
    this.leaveButton.hidden = !this.session
  }

  private async start(code: string | null) {
    if (this.session) return
    if (code === '') { this.status.textContent = 'Enter the room code first.'; this.codeInput.focus(); return }
    const session = new NetworkSession({
      message: (from, message) => this.receive(from, message),
      leave: id => this.remote.remove(id),
      status: text => { this.status.textContent = text; this.hooks.notify(text) },
      roster: players => { this.showRoster(players); this.invalidate() },
    }, this.playerName())
    this.session = session
    this.setBusy(true)
    this.status.textContent = code ? `Connecting to room ${code}…` : 'Opening a room…'
    try {
      if (code) await session.join(code)
      else await session.create()
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
    this.showRoster([])
    this.setBusy(false)
  }

  private showRoster(players: { id: string; name: string }[]) {
    this.roster.replaceChildren(...players.map(player => {
      const item = document.createElement('li')
      item.textContent = player.id === this.session?.id ? `${player.name} (you)` : player.name
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

  kill(enemy: string, direction: THREE.Vector3) {
    this.session?.send({ t: 'kill', enemy, d: tuple(direction) })
  }

  static stateOf(position: THREE.Vector3, yaw: number, weapon: WeaponName | null, dead: boolean): PlayerState {
    return { p: tuple(position), yaw: +yaw.toFixed(3), weapon, dead }
  }

  dispose() { this.abort.abort(); this.session?.close(); this.session = null; this.remote.dispose() }
}
