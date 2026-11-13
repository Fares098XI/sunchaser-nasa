import { Line } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { HorizonGrid } from "../engine/horizon";
import { horizonAtPoint } from "../engine/horizon";
import { skyDirection } from "../engine/sky";

/**
 * Astronaut's eye, played like a game: the camera is your eyes, 2 m above the ground (the height every horizon is
 * computed for). Click to put the helmet on (pointer lock: the mouse looks around, Esc takes it off); without it, drag
 * to look. Wheel zooms the lens; WASD / arrows (or the on-screen stick) to walk, Shift to lope, Space to jump in lunar
 * gravity. Walking has momentum and a bounding stride; the body sways and breathes. Visual only: every number is for
 * the eye point 2 m above the surface. Ground following uses the rendered surface; the walkable area is the analysed region.
 */
export interface Look { yaw: number; pitch: number; fov: number }
export interface Stick { x: number; y: number; run: boolean; jump: boolean }

// km and km/s (scene units). Walk 1.5 m/s, lunar lope 4 m/s (Apollo crews loped at ~2 m/s; a little faster here to
// cross the region), jump 1.8 m/s up in 1.62 m/s^2 gravity.
const WALK_KMS = 0.0015, RUN_KMS = 0.004, G_KMS2 = 0.00162, JUMP_KMS = 0.0018, EYE_KM = 0.002;
const STRIDE_KM = { walk: 0.0009, run: 0.0022 }, BOB_KM = { walk: 0.00004, run: 0.00012 };

/** Pointer lock released this long ago or less: the Esc that released it must not also stand the astronaut up. */
export const justUnlocked = () => performance.now() - Number(document.body.dataset.unlockAt ?? -1e9) < 400;

export function AstronautLook({ start, look, stick, ground, limitKm, onMove, teleport, onEdge }: {
  start: THREE.Vector3; look: React.RefObject<Look>; stick: React.RefObject<Stick>;
  ground: (x: number, z: number) => number;
  /** walkable square: |x|, |z| <= limitKm (the analysed region minus the detailed ground's radius) */
  limitKm: number;
  onMove?: (x: number, z: number) => void;
  teleport?: React.RefObject<{ x: number; z: number } | null>;
  /** true while the walker is pressed against the edge of the walkable area */
  onEdge?: (atEdge: boolean) => void;
}) {
  const { camera, gl, invalidate } = useThree();
  const cur = useRef({ ...look.current });
  const arrive = useRef(0);
  const from = useRef(camera.position.clone());
  const clampKm = (v: number) => Math.max(-limitKm, Math.min(limitKm, v));
  const pos = useRef(new THREE.Vector2(clampKm(start.x), clampKm(start.z)));
  const edge = useRef(false);
  const lastY = useRef(start.y);
  const keys = useRef(new Set<string>());
  const jump = useRef({ h: 0, v: 0 });
  const walkT = useRef(0);
  const lastReport = useRef(0);
  const vel = useRef(new THREE.Vector2()); // ground velocity, km/s (momentum: you do not stop dead on regolith)
  const gait = useRef({ amp: 0, roll: 0 }); // stride amplitude eases in and out with speed
  const dip = useRef(0); // knees bending after a landing, km

  useEffect(() => {
    const el = gl.domElement.parentElement ?? gl.domElement;
    const canvas = gl.domElement;
    let drag: { x: number; y: number; id: number } | null = null;
    const locked = () => document.pointerLockElement === canvas;
    const turn = (dx: number, dy: number, k: number) => {
      look.current.yaw -= dx * k;
      look.current.pitch = Math.max(-80, Math.min(85, look.current.pitch - dy * k));
      invalidate();
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || locked()) return;
      // a mouse click puts the helmet on (pointer lock); touch keeps drag-to-look
      if (e.pointerType === "mouse" && e.target === canvas) { canvas.requestPointerLock?.(); return; }
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    };
    const move = (e: PointerEvent) => {
      if (locked()) return turn(e.movementX, e.movementY, (look.current.fov / 60) * 0.11);
      if (!drag || e.pointerId !== drag.id) return;
      if ((e.buttons & 1) === 0) { drag = null; return; }
      turn(e.clientX - drag.x, -(e.clientY - drag.y), (look.current.fov / 60) * 0.25);
      drag.x = e.clientX; drag.y = e.clientY;
    };
    const lockChange = () => { if (!locked()) { document.body.dataset.unlockAt = String(performance.now()); keys.current.clear(); } };
    document.addEventListener("pointerlockchange", lockChange);
    const up = () => { drag = null; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      look.current.fov = Math.max(8, Math.min(90, look.current.fov * Math.exp(e.deltaY * 0.0012)));
      invalidate();
    };
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const kd = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "Space"].includes(e.code)) {
        e.preventDefault();
        e.stopPropagation(); // the time keys of Explore must not fire while walking
        keys.current.add(e.code);
        invalidate();
      }
    };
    const ku = (e: KeyboardEvent) => { keys.current.delete(e.code); };
    const blur = () => keys.current.clear();
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", kd, true);
    window.addEventListener("keyup", ku, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerlockchange", lockChange);
      if (locked()) document.exitPointerLock?.();
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", kd, true);
      window.removeEventListener("keyup", ku, true);
      window.removeEventListener("blur", blur);
    };
  }, [gl]);

  useFrame(({ clock }, dt) => {
    const cam = camera as THREE.PerspectiveCamera;
    dt = Math.min(dt, 0.1);
    const t = teleport?.current;
    if (t) { pos.current.set(clampKm(t.x), clampKm(t.z)); teleport!.current = null; from.current.copy(cam.position); arrive.current = 0.35; }
    // input: keys + on-screen stick, in the horizontal look direction
    const k = keys.current, s = stick.current;
    let fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0) + (s?.y ?? 0);
    let side = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0) + (s?.x ?? 0);
    const len = Math.hypot(fwd, side);
    if (len > 1) { fwd /= len; side /= len; }
    const run = k.has("ShiftLeft") || k.has("ShiftRight") || !!s?.run;
    const wants = len > 0.05 && arrive.current >= 1;
    const j = jump.current, airborne = j.h > 0 || j.v !== 0;
    // momentum: accelerate toward the wanted velocity, coast to a stop; little grip in the air
    const f = skyDirection(cur.current.yaw, 0); // grid bearing of the view
    const top = run ? RUN_KMS : WALK_KMS;
    const want = wants ? new THREE.Vector2((f[0] * fwd - f[2] * side) * top, (f[2] * fwd + f[0] * side) * top) : new THREE.Vector2();
    const grip = airborne ? 0.4 : wants ? 3.2 : 2.2;
    vel.current.lerp(want, 1 - Math.exp(-dt * grip));
    const speedKms = vel.current.length();
    const moving = speedKms > 0.00005;
    if (moving) {
      const nx = pos.current.x + vel.current.x * dt, nz = pos.current.y + vel.current.y * dt;
      pos.current.set(clampKm(nx), clampKm(nz));
      const atEdge = Math.abs(nx) > limitKm || Math.abs(nz) > limitKm;
      if (atEdge) vel.current.multiplyScalar(0.5);
      if (atEdge !== edge.current) { edge.current = atEdge; onEdge?.(atEdge); }
      if (!airborne) walkT.current += (speedKms * dt) / (run ? STRIDE_KM.run : STRIDE_KM.walk); // strides taken
    } else if (edge.current && len < 0.05) { edge.current = false; onEdge?.(false); }
    // jump in lunar gravity: 1.8 m/s up, 1.62 m/s^2 down (~1.1 s up, ~2.2 s in the air)
    if ((k.has("Space") || s?.jump) && !airborne) { j.v = JUMP_KMS; if (s) s.jump = false; }
    if (j.v !== 0 || j.h > 0) {
      j.h += j.v * dt; j.v -= G_KMS2 * dt;
      if (j.h <= 0) { dip.current = Math.min(0.00012, -j.v * 0.06); j.h = 0; j.v = 0; } // knees take the landing
    }
    dip.current *= Math.exp(-dt * 5);
    // the gait: a bounding stride (|sin|: each step is a small hop), side-to-side roll, slow breathing
    const g = gait.current, ampWant = moving && !airborne ? (run ? BOB_KM.run : BOB_KM.walk) * Math.min(1, speedKms / WALK_KMS) : 0;
    g.amp += (ampWant - g.amp) * (1 - Math.exp(-dt * 6));
    const phase = walkT.current * Math.PI;
    const bob = Math.abs(Math.sin(phase)) * g.amp;
    g.roll = Math.sin(phase) * (g.amp / BOB_KM.walk) * 0.004; // radians: ~0.25 deg per walking step
    const breathe = Math.sin(clock.elapsedTime * 2 * Math.PI * 0.23) * 0.1; // degrees of pitch
    const x = pos.current.x, z = pos.current.y;
    const gy = ground(x, z);
    if (Number.isFinite(gy)) lastY.current = gy;
    const eye = new THREE.Vector3(x, lastY.current + EYE_KM + j.h + bob - dip.current, z);
    // walk-in: from wherever the camera was down to the eye
    if (arrive.current < 1) {
      arrive.current = Math.min(1, arrive.current + dt / 1.6);
      const e = 1 - (1 - arrive.current) ** 3;
      cam.position.lerpVectors(from.current, eye, e);
    } else cam.position.copy(eye);
    const c = cur.current, tl = look.current, a = 1 - Math.exp(-dt * 12);
    c.yaw += (tl.yaw - c.yaw) * a; c.pitch += (tl.pitch - c.pitch) * a; c.fov += (tl.fov - c.fov) * a;
    const d = skyDirection(c.yaw, c.pitch + breathe);
    cam.up.set(0, 1, 0);
    cam.lookAt(cam.position.clone().add(new THREE.Vector3(...d)));
    cam.rotateZ(g.roll);
    if (Math.abs(cam.fov - c.fov) > 1e-3 || cam.near !== 0.0008) { cam.fov = c.fov; cam.near = 0.0008; cam.updateProjectionMatrix(); }
    invalidate(); // breathing keeps the view alive even standing still: astronaut mode renders every frame
    if (moving && onMove && clock.elapsedTime - lastReport.current > 0.12) { lastReport.current = clock.elapsedTime; onMove(x, z); }
  });
  useEffect(() => () => { const cam = camera as THREE.PerspectiveCamera; cam.near = 0.02; cam.fov = 50; cam.updateProjectionMatrix(); }, []);
  return null;
}

/** The computed horizon at the point, as a thin line on the sky (2 deg azimuth bins, as stored). */
export function Skyline({ hg, fr, fc, eye }: { hg: HorizonGrid; fr: number; fc: number; eye: THREE.Vector3 }) {
  const ref = useRef<THREE.Group>(null);
  const pts = useMemo(() => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i <= hg.nAz * 2; i++) {
      const az = (i * 360) / (hg.nAz * 2);
      const d = skyDirection(az, horizonAtPoint(hg, fr, fc, az));
      out.push(new THREE.Vector3(...d).multiplyScalar(2500));
    }
    return out;
  }, [hg, fr, fc]);
  // the line lives at infinity: it follows the camera, like the stars
  useFrame(({ camera }) => ref.current?.position.copy(camera.position));
  return (
    <group ref={ref} position={eye}>
      <Line points={pts} color="#6fe3e1" lineWidth={1.4} transparent opacity={0.75} depthTest={false} renderOrder={10} />
    </group>
  );
}
