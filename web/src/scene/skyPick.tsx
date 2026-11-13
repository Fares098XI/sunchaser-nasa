import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * Sun and Earth gestures, handled on the DOM before the camera controls see the pointer:
 * press on the Sun and drag = move time (Grab the Sun); tap the Sun or Earth = fly to it.
 * Every drag ends on pointerup, pointercancel, lost capture or window blur, so the Sun never sticks to the mouse.
 */
export interface ScreenBody { x: number; y: number; r: number; on: boolean }
export interface SkyHits { sun: ScreenBody; earth: ScreenBody; camera: THREE.PerspectiveCamera | null; w: number; h: number }
export const newHits = (): SkyHits => ({
  sun: { x: 0, y: 0, r: 0, on: false }, earth: { x: 0, y: 0, r: 0, on: false }, camera: null, w: 1, h: 1,
});

interface Tracked { pos: THREE.Vector3; radius: number }

/** Inside the Canvas: projects the Sun and Earth to screen pixels every frame. */
export function SkyTracker({ hits, sun, earth }: { hits: React.RefObject<SkyHits>; sun: Tracked | null; earth: Tracked | null }) {
  const { camera, size } = useThree();
  const v = useRef(new THREE.Vector3()).current;
  useFrame(() => {
    const h = hits.current, cam = camera as THREE.PerspectiveCamera;
    h.camera = cam;
    h.w = size.width;
    h.h = size.height;
    const put = (b: ScreenBody, t: Tracked | null) => {
      if (!t) { b.on = false; return; }
      v.copy(t.pos).project(cam);
      b.on = v.z > -1 && v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      b.x = ((v.x + 1) / 2) * size.width;
      b.y = ((1 - v.y) / 2) * size.height;
      const d = cam.position.distanceTo(t.pos);
      b.r = (Math.atan(t.radius / d) / Math.tan((cam.fov * Math.PI) / 360)) * (size.height / 2);
    };
    put(h.sun, sun);
    put(h.earth, earth);
  });
  return null;
}

/** View direction under a client pixel. */
export function rayAt(h: SkyHits, clientX: number, clientY: number, rect: DOMRect) {
  const p = new THREE.Vector3(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, 0.5);
  p.unproject(h.camera!);
  return p.sub(h.camera!.position).normalize();
}

export interface SkyHandlers {
  /** dragging the Sun: the view direction under the pointer */
  onSunDrag?: (dir: THREE.Vector3) => void;
  onSunDragEnd?: () => void;
  onTap?: (body: "sun" | "earth") => void;
}

export function useSkyGestures(wrap: React.RefObject<HTMLElement | null>, hits: React.RefObject<SkyHits>, handlers: SkyHandlers) {
  const cb = useRef(handlers);
  cb.current = handlers;
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let drag: { id: number; x0: number; y0: number; moved: boolean; body: "sun" | "earth" } | null = null;
    const pick = (e: PointerEvent): "sun" | "earth" | null => {
      const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, h = hits.current;
      const near = (b: ScreenBody, min: number) => b.on && Math.hypot(b.x - x, b.y - y) <= Math.max(min, b.r * 1.5);
      return cb.current.onSunDrag || cb.current.onTap ? (near(h.sun, 28) ? "sun" : near(h.earth, 20) ? "earth" : null) : null;
    };
    const end = (tap: boolean) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      el.style.cursor = "";
      try { el.releasePointerCapture(d.id); } catch { /* already released */ }
      if (d.body === "sun" && d.moved) cb.current.onSunDragEnd?.();
      if (tap && !d.moved) cb.current.onTap?.(d.body);
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || drag) return;
      const body = pick(e);
      if (!body) return;
      e.stopPropagation();
      e.preventDefault();
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, body };
      try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      el.style.cursor = body === "sun" ? "grabbing" : "pointer";
    };
    const move = (e: PointerEvent) => {
      if (!drag) {
        const b = e.buttons === 0 ? pick(e) : null;
        el.style.cursor = b === "sun" ? (cb.current.onSunDrag ? "grab" : "pointer") : b === "earth" ? "pointer" : "";
        return;
      }
      if (e.pointerId !== drag.id) return;
      e.stopPropagation();
      if ((e.buttons & 1) === 0) { end(false); return; } // button already released somewhere we did not see
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 5) drag.moved = true;
      if (drag.moved && drag.body === "sun" && cb.current.onSunDrag) cb.current.onSunDrag(rayAt(hits.current, e.clientX, e.clientY, el.getBoundingClientRect()));
    };
    const up = (e: PointerEvent) => { if (drag && e.pointerId === drag.id) { e.stopPropagation(); end(true); } };
    const cancel = () => end(false);
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    el.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      el.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, []);
}
