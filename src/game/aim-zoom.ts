import * as THREE from 'three'

/** Magnification while aiming down sights with anything but the scoped sniper rifle. */
export const AIM_ZOOM = 1.35

/**
 * A light eased FOV zoom for right-click aiming. It owns the camera FOV only while zoomed and
 * restores the exact unzoomed value, so the controller and the sniper scope keep their own FOV logic.
 */
export class AimZoom {
  private amount = 0
  private base: number | null = null

  /** Current magnification, for scaling mouse sensitivity. */
  get factor() { return 1 + (AIM_ZOOM - 1) * this.amount }

  update(camera: THREE.PerspectiveCamera, zoomed: boolean, dt: number, reducedMotion: boolean) {
    if (!zoomed && this.base === null) return
    this.base ??= camera.fov
    const target = zoomed ? 1 : 0
    this.amount = reducedMotion ? target : this.amount + (target - this.amount) * (1 - Math.exp(-dt * 14))
    if (!zoomed && this.amount < 0.01) { this.reset(camera); return }
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.base) / 2) / this.factor))
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix() }
  }

  /** Snap back immediately (scope, cinematics, restarts). */
  reset(camera: THREE.PerspectiveCamera) {
    if (this.base !== null && camera.fov !== this.base) { camera.fov = this.base; camera.updateProjectionMatrix() }
    this.base = null
    this.amount = 0
  }
}
