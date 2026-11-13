/**
 * The 3D region's horizon grid on the GPU (S5b, docs/METHODS.md §21): one fragment per (cell, azimuth) marches its ray
 * through the terrain layers with engine/pinregion.stepHorizon's rule and geometry (sinElev). Plain WebGL2, so it
 * runs in a worker on an OffscreenCanvas. Output: horizon in steps of `quantum` degrees, layout [az][row][col].
 * The atlas is drawn one row of azimuth tiles at a time (a single draw of all 7.2 million rays could exceed the
 * driver's watchdog on an integrated GPU), each read back before the next.
 */
import type { Layer } from "../engine/pinhorizon";
import { PIN_REGION } from "../engine/pinregion";
import { R_MOON_M } from "../engine/frames";

const VS = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uL0, uL1, uL2;
uniform vec4 uG0, uG1, uG2;          // x0, y0, res, n of each layer
uniform vec4 uCells;                 // x0, y0, cell size, cells per side
uniform float uTilesX, uNAz, uZ, uFrac, uReach, uQuantum;
out vec4 outColor;
const float R = ${R_MOON_M.toFixed(1)};

float bil(sampler2D t, vec4 g, vec2 p) {     // NaN-free: returns -1e9 outside the layer
  float fc = (p.x - g.x) / g.z - 0.5, fr = (g.y - p.y) / g.z - 0.5;
  float c = floor(fc), r = floor(fr);
  if (r < 0.0 || c < 0.0 || r >= g.w - 1.0 || c >= g.w - 1.0) return -1e9;
  float a = fc - c, b = fr - r;
  ivec2 i = ivec2(int(c), int(r));
  float h00 = texelFetch(t, i, 0).r, h01 = texelFetch(t, i + ivec2(1, 0), 0).r;
  float h10 = texelFetch(t, i + ivec2(0, 1), 0).r, h11 = texelFetch(t, i + ivec2(1, 1), 0).r;
  return (h00 * (1.0 - a) + h01 * a) * (1.0 - b) + (h10 * (1.0 - a) + h11 * a) * b;
}

// engine/pinregion.sinElev, line by line
float sinElev(float ox, float oy, float oh, float dx, float dy, float h) {
  float k = 1.0 / (4.0 * R * R), t2p = (ox * ox + oy * oy) * k, dt = (2.0 * ox * dx + dx * dx + 2.0 * oy * dy + dy * dy) * k;
  float t2q = t2p + dt, fp = (R + oh) / (1.0 + t2p);
  float df = ((h - oh) * (1.0 + t2p) - dt * (R + oh)) / ((1.0 + t2q) * (1.0 + t2p));
  float vx = (fp * dy + df * (oy + dy)) / R, vy = (fp * dx + df * (ox + dx)) / R, vz = fp * dt - df * (1.0 - t2q);
  float ux = oy / R / (1.0 + t2p), uy = ox / R / (1.0 + t2p), uz = -(1.0 - t2p) / (1.0 + t2p);
  return (vx * ux + vy * uy + vz * uz) / sqrt(vx * vx + vy * vy + vz * vz);
}

void main() {
  vec2 f = floor(gl_FragCoord.xy), tile = floor(f / uCells.w), cell = f - tile * uCells.w;
  float az = tile.y * uTilesX + tile.x;
  if (az >= uNAz) { outColor = vec4(0.0); return; }
  float ox = uCells.x + (cell.x + 0.5) * uCells.z, oy = uCells.y - (cell.y + 0.5) * uCells.z;
  float a = radians(az * 360.0 / uNAz), sa = sin(a), ca = cos(a);
  float oh = bil(uL0, uG0, vec2(ox, oy)) + uZ;
  float best = -1.0, s = uG0.z * 0.5;
  for (int i = 0; i < 6000; i++) {
    if (s > uReach) break;
    vec2 p = vec2(ox + s * sa, oy + s * ca);
    float h = bil(uL0, uG0, p), res = uG0.z;
    if (h < -1e8) { h = bil(uL1, uG1, p); res = uG1.z; }
    if (h < -1e8) { h = bil(uL2, uG2, p); res = uG2.z; }
    if (h < -1e8) break;
    best = max(best, sinElev(ox, oy, oh, s * sa, s * ca, h));
    s += min(max(uFrac * s, res * 0.5), res);
  }
  float u = clamp(floor(degrees(asin(clamp(best, -1.0, 1.0))) / uQuantum + 0.5), -32768.0, 32767.0) + 32768.0;
  outColor = vec4(floor(u / 256.0), mod(u, 256.0), 0.0, 255.0) / 255.0;
}`;

function compile(gl: WebGL2RenderingContext) {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("horizon shader: " + gl.getShaderInfoLog(s));
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("horizon program: " + gl.getProgramInfoLog(prog));
  return prog;
}

function layerTexture(gl: WebGL2RenderingContext, L: Layer, unit: number) {
  const t = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, L.n, L.n, 0, gl.RED, gl.FLOAT, L.dem);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  return t;
}

/** Horizon grid (int16 steps of quantum deg, [az][row][col]) of the region's cells; layers: [59 m, 474 m, 1.9 km]. */
export async function gpuHorizonGrid(gl: WebGL2RenderingContext, layers: Layer[], quantum: number,
  onProgress?: (f: number) => void): Promise<Int16Array> {
  const { cellN, cell, nAz, z, frac, reach } = PIN_REGION, tilesX = 15, tilesY = Math.ceil(nAz / tilesX);
  const W = cellN * tilesX, H = cellN * tilesY;
  if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < Math.max(W, H)) throw new Error("GPU texture size too small");
  const prog = compile(gl);
  gl.useProgram(prog);
  const tex = layers.map((L, i) => layerTexture(gl, L, i));
  const u = (n: string) => gl.getUniformLocation(prog, n);
  layers.forEach((L, i) => { gl.uniform1i(u(`uL${i}`), i); gl.uniform4f(u(`uG${i}`), L.x0, L.y0, L.res, L.n); });
  const half = (cellN * cell) / 2;
  gl.uniform4f(u("uCells"), -half, half, cell, cellN);
  gl.uniform1f(u("uTilesX"), tilesX); gl.uniform1f(u("uNAz"), nAz); gl.uniform1f(u("uZ"), z);
  gl.uniform1f(u("uFrac"), frac); gl.uniform1f(u("uReach"), reach); gl.uniform1f(u("uQuantum"), quantum);
  const target = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0 + 3);
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  gl.viewport(0, 0, W, H);
  gl.enable(gl.SCISSOR_TEST);
  const out = new Int16Array(nAz * cellN * cellN), strip = new Uint8Array(W * cellN * 4);
  for (let ty = 0; ty < tilesY; ty++) {
    gl.scissor(0, ty * cellN, W, cellN);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, ty * cellN, W, cellN, gl.RGBA, gl.UNSIGNED_BYTE, strip); // waits for this strip only
    for (let tx = 0; tx < tilesX; tx++) {
      const az = ty * tilesX + tx;
      if (az >= nAz) break;
      for (let r = 0; r < cellN; r++) for (let c = 0; c < cellN; c++) {
        const o = 4 * (r * W + tx * cellN + c);
        out[(az * cellN + r) * cellN + c] = strip[o] * 256 + strip[o + 1] - 32768;
      }
    }
    onProgress?.((ty + 1) / tilesY);
    await new Promise((res) => setTimeout(res, 0));
  }
  gl.disable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  [...tex, target].forEach((t) => gl.deleteTexture(t));
  gl.deleteFramebuffer(fb);
  gl.deleteProgram(prog);
  return out;
}
