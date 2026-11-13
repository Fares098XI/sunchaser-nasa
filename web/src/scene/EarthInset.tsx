import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useEffect } from "react";
import * as THREE from "three";
import { skyDirection } from "../engine/sky";
import { useEarthMaterial } from "./Sky";

interface Body { az: number; el: number; dist: number }

/** The camera on the Moon looking at Earth: Earth at the origin in its true orientation, Sun from the true side. */
function Look({ dir }: { dir: [number, number, number] }) {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(-dir[0] * 4.2, -dir[1] * 4.2, -dir[2] * 4.2);
    camera.up.set(0, 1, 0); // local vertical stays up, as an observer at the site sees it
    camera.lookAt(0, 0, 0);
  }, [dir[0], dir[1], dir[2]]);
  return null;
}

function Globe({ quat, sun }: { quat: THREE.Quaternion; sun: [number, number, number] }) {
  const material = useEarthMaterial();
  material.uniforms.uSunDir.value.set(...sun);
  material.uniforms.uExposure.value = 1.15;
  return (
    <mesh quaternion={quat} material={material}>
      <sphereGeometry args={[1, 96, 48]} />
    </mesh>
  );
}

/** "Earth from here": true phase, the continents that face the Moon right now, and Earth's height above the horizon. */
/** Kept mounted across views (`hidden` pauses it): its WebGL canvas is created once, not on every return to Explore. */
export function EarthInset({ earth, sun, quat, visible, onOpen, hidden }: { earth: Body; sun: Body; quat: THREE.Quaternion; visible: number; onOpen?: () => void; hidden?: boolean }) {
  const e = skyDirection(earth.az, earth.el), s = skyDirection(sun.az, sun.el);
  const lit = (1 - (e[0] * s[0] + e[1] * s[1] + e[2] * s[2])) / 2;
  return (
    <figure className={`earth-inset glass ${hidden ? "is-hidden" : ""}`} aria-hidden={hidden} aria-label={`Earth from the site: ${Math.round(lit * 100)}% lit, ${earth.el.toFixed(1)} degrees elevation`}
      onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onOpen?.(); }} title="Fly to Earth">
      <div className="earth-inset-view">
        <Canvas camera={{ fov: 30, near: 0.1, far: 20 }} dpr={[1, 2]} gl={{ antialias: true }} flat frameloop="demand">
          <Look dir={e} />
          <Suspense fallback={null}><Globe quat={quat} sun={s} /></Suspense>
        </Canvas>
      </div>
      <figcaption>
        <span className="eyebrow">Earth from here</span>
        <span className="num">{Math.round(lit * 100)}% lit · {earth.el >= 0 ? `${earth.el.toFixed(1)}° up` : "below the horizon"}</span>
        <span className="num dim">{visible > 0 ? `${Math.round(visible * 100)}% above the terrain` : "hidden by terrain"}</span>
      </figcaption>
    </figure>
  );
}
