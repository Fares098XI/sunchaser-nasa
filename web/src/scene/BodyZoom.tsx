import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * Telephoto move into the Sun or Earth before their close-up opens: the camera turns to the body and the lens zooms
 * until it fills ~40 % of the frame (the close-up starts at that same size, so the hand-off is a match cut under a
 * cross-fade). When the close-up closes, the move plays backwards.
 */
export interface ZoomTarget { pos: THREE.Vector3; radius: number }

export function BodyZoom({ target, active, controls, onArrived }: {
  target: ZoomTarget | null; active: boolean; controls?: React.RefObject<{ enabled: boolean } | null>;
  onArrived: () => void;
}) {
  const { camera, invalidate } = useThree();
  const saved = useRef<{ q: THREE.Quaternion; fov: number } | null>(null);
  const t = useRef(0);
  const arrived = useRef(false);
  const last = useRef<ZoomTarget | null>(null); // the zoom-out still needs the body after the request is cleared
  if (target) last.current = target;
  useEffect(() => {
    if (active && target && !saved.current) {
      const cam = camera as THREE.PerspectiveCamera;
      saved.current = { q: cam.quaternion.clone(), fov: cam.fov };
      t.current = 0;
      arrived.current = false;
      if (controls?.current) controls.current.enabled = false;
    }
    invalidate();
  }, [active, target]);
  useFrame((_, dt) => {
    const s = saved.current, cam = camera as THREE.PerspectiveCamera, tg = last.current;
    if (!s || !tg) return;
    dt = Math.min(dt, 1 / 30); // a slow frame never makes the lens jump
    t.current = Math.max(0, Math.min(1, t.current + (active ? dt / 1.15 : -dt / 0.9)));
    const e = t.current < 0.5 ? 4 * t.current ** 3 : 1 - (-2 * t.current + 2) ** 3 / 2;
    const look = new THREE.Matrix4().lookAt(cam.position, tg.pos, cam.up);
    const q = new THREE.Quaternion().setFromRotationMatrix(look);
    const ang = Math.asin(Math.min(1, tg.radius / cam.position.distanceTo(tg.pos)));
    const fovEnd = Math.max(0.5, ((2 * ang) / 0.4) * (180 / Math.PI));
    cam.quaternion.slerpQuaternions(s.q, q, Math.min(1, e * 1.35));
    cam.fov = s.fov + (fovEnd - s.fov) * e;
    cam.updateProjectionMatrix();
    invalidate();
    if (active && t.current >= 1 && !arrived.current) { arrived.current = true; onArrived(); }
    if (!active && t.current <= 0) {
      cam.quaternion.copy(s.q);
      cam.fov = s.fov;
      cam.updateProjectionMatrix();
      saved.current = null;
      if (controls?.current) controls.current.enabled = true;
    }
  });
  return null;
}
