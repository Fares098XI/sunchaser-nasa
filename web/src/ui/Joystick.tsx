import { useRef, useState } from "react";
import type { Stick } from "../scene/Astronaut";

/** On-screen stick for touch screens (and mice): drag the knob to walk; buttons to run and jump. */
export function Joystick({ stick }: { stick: React.RefObject<Stick> }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0, on: false });
  const [run, setRun] = useState(false);
  const set = (x: number, y: number, on: boolean) => {
    setKnob({ x, y, on });
    stick.current.x = x;
    stick.current.y = -y; // up on screen = forward
  };
  const fromEvent = (e: React.PointerEvent) => {
    const r = base.current!.getBoundingClientRect(), R = r.width / 2;
    let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    set(x, y, true);
  };
  return (
    <div className="joy" aria-label="Walk controls">
      <div ref={base} className="joy-base" role="application" aria-label="Walk stick"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); fromEvent(e); }}
        onPointerMove={(e) => { if (knob.on) fromEvent(e); }}
        onPointerUp={() => set(0, 0, false)} onPointerCancel={() => set(0, 0, false)} onLostPointerCapture={() => set(0, 0, false)}>
        <div className="joy-knob" style={{ transform: `translate(${knob.x * 34}px, ${knob.y * 34}px)` }} />
      </div>
      <div className="joy-buttons">
        <button className={run ? "on" : ""} onClick={() => { setRun(!run); stick.current.run = !run; }} aria-pressed={run}>Run</button>
        <button onClick={() => { stick.current.jump = true; }}>Jump</button>
      </div>
    </div>
  );
}
