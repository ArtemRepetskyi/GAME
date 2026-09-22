import type { DataConnection, Peer } from 'peerjs'
import type { Vec3, WeaponName } from './types'

/**
 * Online co-op over WebRTC data channels (PeerJS). The page stays fully static, so it works on
 * GitHub Pages: the public PeerJS broker only introduces peers, game traffic goes peer to peer.
 * Star topology: the room creator is the host and relays every guest message to the other guests.
 */
export type PlayerState = { p: Vec3; yaw: number; weapon: WeaponName | null; dead: boolean }
export type NetMessage =
  | { t: 'hello'; name: string }
  | { t: 'roster'; players: { id: string; name: string }[] }
  | { t: 'state'; s: PlayerState }
  | { t: 'shot'; o: Vec3; e: Vec3; weapon?: WeaponName; pellet?: boolean }
  | { t: 'kill'; enemy: string; d: Vec3 }
  | { t: 'leave' }
/** Every relayed message carries its original sender. */
type Envelope = NetMessage & { from: string }

export type NetworkEvents = {
  message: (from: string, message: NetMessage) => void
  leave: (id: string) => void
  status: (text: string) => void
  roster: (players: { id: string; name: string }[]) => void
}

const PREFIX = 'operation-ink-room-'
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function roomCode() {
  let code = ''
  for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return code
}

/** `?peer=host:port` points at a self-hosted PeerJS server instead of the free public one. */
function brokerOptions() {
  const custom = new URLSearchParams(location.search).get('peer')
  if (!custom) return {}
  const url = new URL(custom.includes('://') ? custom : `${location.protocol}//${custom}`)
  const secure = url.protocol === 'https:'
  return { host: url.hostname, port: Number(url.port) || (secure ? 443 : 80), path: url.pathname === '/' ? '/' : url.pathname, secure }
}

export function normalizeCode(code: string) { return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) }

export class NetworkSession {
  code = ''
  host = false
  id = ''
  private peer: Peer | null = null
  private links = new Map<string, DataConnection>()
  private names = new Map<string, string>()

  constructor(private events: NetworkEvents, private name: string) {}

  get connected() { return this.links.size > 0 }
  get players() { return [...this.names].map(([id, name]) => ({ id, name })) }

  async create(code = roomCode()) {
    this.host = true
    this.code = code
    const peer = await this.open(PREFIX + code)
    this.names.set(this.id, this.name)
    this.events.status(`Room ${code} is open. Share the code or link with friends.`)
    this.events.roster(this.players)
    peer.on('connection', link => {
      link.on('open', () => { this.links.set(link.peer, link) })
      link.on('data', data => this.receive(link.peer, data as NetMessage))
      link.on('close', () => this.drop(link.peer))
      link.on('error', () => this.drop(link.peer))
    })
  }

  async join(code: string) {
    this.host = false
    this.code = code
    const peer = await this.open()
    const link = peer.connect(PREFIX + code, { reliable: true })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Room ${code} did not answer.`)), 12000)
      link.on('open', () => { clearTimeout(timer); resolve() })
      link.on('error', error => { clearTimeout(timer); reject(error) })
      peer.on('error', error => { clearTimeout(timer); reject(error.type === 'peer-unavailable' ? new Error(`Room ${code} was not found.`) : error) })
    })
    this.links.set(link.peer, link)
    link.on('data', data => this.receive(link.peer, data as Envelope))
    link.on('close', () => { this.events.status('The host closed the room.'); this.leaveAll() })
    link.send({ t: 'hello', name: this.name })
    this.events.status(`Joined room ${code}.`)
  }

  private open(id?: string) {
    return import('peerjs').then(({ Peer }) => new Promise<Peer>((resolve, reject) => {
      const options = brokerOptions()
      const peer = id ? new Peer(id, options) : new Peer(options)
      this.peer = peer
      peer.on('open', own => { this.id = own; resolve(peer) })
      peer.on('error', error => {
        if (!this.id) reject(error.type === 'unavailable-id' ? new Error('That room code is taken. Try again.') : error)
        else if (error.type === 'network' || error.type === 'server-error') this.events.status('Lost the matchmaking server. Players already connected stay connected.')
      })
    }))
  }

  /** Send one of our own messages to everybody else. */
  send(message: NetMessage) {
    if (!this.links.size) return
    const envelope: Envelope = { ...message, from: this.id }
    for (const link of this.links.values()) if (link.open) link.send(envelope)
  }

  private receive(peer: string, data: NetMessage | Envelope) {
    if (!data || typeof data !== 'object' || typeof data.t !== 'string') return
    if (this.host) {
      // Guests cannot speak for anybody else.
      const message = { ...data, from: peer } as Envelope
      if (message.t === 'hello') {
        this.names.set(peer, String(message.name).slice(0, 24) || 'Player')
        this.broadcastRoster()
        this.events.status(`${this.names.get(peer)} joined.`)
        return
      }
      for (const [id, link] of this.links) if (id !== peer && link.open) link.send(message)
      this.events.message(peer, message)
      return
    }
    const message = data as Envelope
    if (message.t === 'roster') {
      this.names = new Map(message.players.map(player => [player.id, player.name]))
      for (const id of [...this.known]) if (!this.names.has(id)) { this.known.delete(id); this.events.leave(id) }
      this.events.roster(this.players)
      return
    }
    if (message.t === 'leave') { this.events.leave(message.from); return }
    if (message.from) { this.known.add(message.from); this.events.message(message.from, message) }
  }
  private known = new Set<string>()

  private broadcastRoster() {
    const roster: Envelope = { t: 'roster', players: this.players, from: this.id }
    for (const link of this.links.values()) if (link.open) link.send(roster)
    this.events.roster(this.players)
  }

  private drop(peer: string) {
    if (!this.links.has(peer)) return
    this.links.delete(peer)
    const name = this.names.get(peer) ?? 'A player'
    this.names.delete(peer)
    this.events.leave(peer)
    this.events.status(`${name} left.`)
    this.broadcastRoster()
  }

  nameOf(id: string) { return this.names.get(id) ?? 'Player' }

  private leaveAll() {
    for (const id of this.links.keys()) this.events.leave(id)
    for (const id of this.known) this.events.leave(id)
    this.known.clear()
    this.links.clear()
    this.names.clear()
    this.events.roster([])
  }

  close() {
    this.send({ t: 'leave' })
    for (const link of this.links.values()) link.close()
    this.leaveAll()
    this.peer?.destroy()
    this.peer = null
    this.code = ''
    this.id = ''
  }
}
