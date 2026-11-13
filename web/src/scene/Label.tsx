import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * A DOM label that follows a 3D point. The element lives outside the Canvas (plain React DOM), so unmounting the
 * Canvas never tears down a nested React root (drei <Html> did, and crashed on view switches).
 */
export function Projector({ at, el, onSphere, range }: {
  at: THREE.Vector3 | [number, number, number]; el: React.RefObject<HTMLElement | null>;
  /** the point sits on a sphere centred at the origin: hide it when it is on the far side */
  onSphere?: boolean;
  /** show only while the camera is within this distance range of the point (scene units) */
  range?: [number, number];
}) {
  const { camera, size } = useThree();
  const v = new THREE.Vector3();
  useFrame(() => {
    const e = el.current;
    if (!e) return;
    v.set(...(Array.isArray(at) ? at : at.toArray()));
    const d = camera.position.distanceTo(v);
    const facing = (!onSphere || v.dot(camera.position.clone().sub(v)) > 0) && (!range || (d >= range[0] && d <= range[1]));
    v.project(camera);
    const on = facing && v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
    e.style.opacity = on ? "1" : "0";
    e.style.transform = `translate(-50%, -100%) translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px)`;
  });
  return null;
}
