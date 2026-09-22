import * as THREE from 'three'
import { EnemyActor } from './actors'
import type { PlayerState } from './network'
import type { WeaponName } from './types'

/** Teammates are green so they never read as black guards or the blue hostage. */
const TEAMMATE = 0x23a047

type Remote = {
  actor: EnemyActor | null
  loading: boolean
  weapon: WeaponName
  label: THREE.Sprite
  target: THREE.Vector3
  position: THREE.Vector3
  yaw: number
  targetYaw: number
  speed: number
  dead: boolean
  seen: number
}

function nameSprite(name: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 64
  const context = canvas.getContext('2d')!
  context.font = '600 30px "Trebuchet MS", sans-serif'
  context.textAlign = 'center'; context.textBaseline = 'middle'
  context.lineWidth = 6; context.strokeStyle = '#ffffff'
  context.strokeText(name, 128, 32)
  context.fillStyle = '#1b7a37'
  context.fillText(name, 128, 32)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, toneMapped: false }))
  sprite.scale.set(1.2, 0.3, 1)
  sprite.renderOrder = 10
  sprite.userData.noCollision = true
  return sprite
}

/** Other players in the room, drawn with the shared stickman rig and smoothed between network updates. */
export class RemotePlayers {
  private players = new Map<string, Remote>()
  private disposed = false

  constructor(private scene: THREE.Scene, private invalidate: () => void) {}

  get count() { return this.players.size }

  apply(id: string, name: string, state: PlayerState) {
    let remote = this.players.get(id)
    const target = new THREE.Vector3(...state.p)
    if (!remote) {
      const label = nameSprite(name)
      this.scene.add(label)
      remote = { actor: null, loading: false, weapon: state.weapon ?? 'pistol', label, target, position: target.clone(),
        yaw: state.yaw, targetYaw: state.yaw, speed: 0, dead: state.dead, seen: performance.now() }
      this.players.set(id, remote)
    }
    // A large jump (checkpoint retry, restart) snaps instead of sliding across the map.
    if (remote.position.distanceTo(target) > 6) remote.position.copy(target)
    remote.target.copy(target)
    remote.targetYaw = state.yaw
    remote.dead = state.dead
    remote.seen = performance.now()
    const weapon = state.weapon ?? 'pistol'
    if (!remote.actor || weapon !== remote.weapon) { remote.weapon = weapon; void this.load(id, remote) }
    this.invalidate()
  }

  private async load(id: string, remote: Remote) {
    if (remote.loading) return
    remote.loading = true
    const weapon = remote.weapon
    const actor = await EnemyActor.create(weapon)
    remote.loading = false
    if (this.disposed || this.players.get(id) !== remote) { actor.dispose(); return }
    if (remote.actor) { remote.actor.root.removeFromParent(); remote.actor.dispose() }
    actor.setColor(TEAMMATE)
    actor.root.name = 'Online teammate'
    actor.root.position.copy(remote.position)
    actor.root.rotation.y = remote.yaw
    this.scene.add(actor.root)
    remote.actor = actor
    if (remote.weapon !== weapon) void this.load(id, remote)
    this.invalidate()
  }

  /** The muzzle of a teammate, for drawing their bullet trails from the gun instead of the eye. */
  muzzle(id: string) { return this.players.get(id)?.actor?.muzzle() ?? null }

  shoot(id: string) { this.players.get(id)?.actor?.shoot() }

  remove(id: string) {
    const remote = this.players.get(id)
    if (!remote) return
    this.players.delete(id)
    remote.label.removeFromParent()
    remote.label.material.map?.dispose(); remote.label.material.dispose()
    if (remote.actor) { remote.actor.root.removeFromParent(); remote.actor.dispose() }
    this.invalidate()
  }

  clear() { for (const id of [...this.players.keys()]) this.remove(id) }

  /** Returns true while any teammate is still moving towards its latest reported position. */
  update(dt: number) {
    let moving = false
    const now = performance.now()
    for (const [id, remote] of this.players) {
      // Peers that stopped reporting (closed tab without a goodbye) disappear after a while.
      if (now - remote.seen > 15000) { this.remove(id); continue }
      const before = remote.position.clone()
      const blend = 1 - Math.exp(-dt * 12)
      remote.position.lerp(remote.target, blend)
      const turn = Math.atan2(Math.sin(remote.targetYaw - remote.yaw), Math.cos(remote.targetYaw - remote.yaw))
      remote.yaw += turn * blend
      const horizontal = Math.hypot(remote.position.x - before.x, remote.position.z - before.z)
      remote.speed = dt > 0 ? THREE.MathUtils.lerp(remote.speed, horizontal / dt, 1 - Math.exp(-dt * 8)) : remote.speed
      const walking = remote.speed > 0.35 && !remote.dead
      remote.label.position.copy(remote.position).add(new THREE.Vector3(0, remote.dead ? 0.6 : 2.15, 0))
      if (remote.actor) {
        remote.actor.root.position.copy(remote.position)
        // The rig faces +Z at zero yaw, the first-person camera looks down -Z.
        remote.actor.root.rotation.y = remote.yaw + Math.PI
        remote.actor.update(dt, remote.dead ? 'dead' : walking ? 'patrol' : 'guard', walking, undefined, remote.speed)
      }
      if (remote.position.distanceToSquared(remote.target) > 1e-4 || walking || Math.abs(turn) > 1e-3) moving = true
    }
    // Idle animation keeps breathing, so keep drawing while anyone is visible.
    return moving || this.players.size > 0
  }

  dispose() { this.disposed = true; this.clear() }
}
