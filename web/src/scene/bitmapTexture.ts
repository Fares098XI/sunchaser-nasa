import { useLoader } from "@react-three/fiber";
import * as THREE from "three";
import { whenIdle } from "../data/background";

/**
 * Textures from JPEGs decoded off the main thread (createImageBitmap). A plain TextureLoader image is decoded
 * synchronously at its first GPU upload: 0.3-0.6 s per 4k map on an integrated laptop, a frozen globe while dragging.
 */
export class BitmapTextureLoader extends THREE.Loader<THREE.Texture> {
  /** Set by useBitmapTexture: a map that still fails after one retry becomes a plain stand-in instead of an error. */
  fallback = false;

  load(url: string, onLoad?: (t: THREE.Texture) => void, onProgress?: (e: ProgressEvent) => void, onError?: (e: unknown) => void) {
    const l = new THREE.ImageBitmapLoader(this.manager);
    l.setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const done = (bmp: ImageBitmap) => {
      const t = new THREE.Texture(bmp as unknown as HTMLImageElement);
      t.flipY = false; // already flipped while decoding (WebGL ignores flipY for bitmaps)
      t.needsUpdate = true;
      onLoad?.(t);
    };
    const fail = (e: unknown) => {
      if (!this.fallback) return onError?.(e);
      console.warn(`${url}: download failed, shown without it`, e);
      onLoad?.(standIn(url));
    };
    // one retry: a dropped connection on venue Wi-Fi must not blank the page (a thrown load error unmounts the scene)
    l.load(url, done, onProgress, () => setTimeout(() => l.load(url, done, onProgress, fail), 1500));
    return new THREE.Texture();
  }
}

/** 1x1 stand-in: a flat normal (128,128,255) for normal maps, mid grey for colour maps. Visual only: no number reads it. */
export function standIn(url: string) {
  const t = new THREE.DataTexture(new Uint8Array(/normal/i.test(url) ? [128, 128, 255, 255] : [96, 96, 96, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

export function useBitmapTexture(url: string): THREE.Texture;
export function useBitmapTexture(urls: string[]): THREE.Texture[];
export function useBitmapTexture(u: string | string[]) {
  return useLoader(BitmapTextureLoader, u, (loader) => { (loader as BitmapTextureLoader).fallback = true; });
}

/**
 * Uploads every texture a scene uses, one per pause of the user's input: a 4k map takes 0.2-0.4 s to reach an
 * integrated GPU, so one draw that uploads them all at once froze the page for over a second.
 * Resolves false if `live()` turned false meanwhile.
 */
export async function uploadQuietly(gl: THREE.WebGLRenderer, scene: THREE.Object3D, live: () => boolean, quietMs = 1200) {
  const all = new Set<THREE.Texture>();
  scene.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      for (const v of Object.values(m as unknown as Record<string, unknown>)) if (v instanceof THREE.Texture) all.add(v);
      const u = (m as THREE.ShaderMaterial).uniforms;
      if (u) for (const k in u) if (u[k]?.value instanceof THREE.Texture) all.add(u[k].value);
    }
  });
  // on the GPU at its current version (also when another warm-up, or a frame, uploaded it meanwhile)
  const current = (t: THREE.Texture) => (gl.properties.get(t) as { __version?: number }).__version === t.version;
  for (const t of all) {
    if (t.version === 0) continue; // no data yet
    // texture arrays (a region's horizons: 22 MB, ~0.9 s) go up in eighths; until the last one the texture stays marked
    // stale, so a frame drawn meanwhile uploads it whole instead of using missing layers
    const depth = t instanceof THREE.DataArrayTexture ? t.image.depth : 0;
    for (let tries = 0; !current(t) && tries < 12; tries++) { // (12: a texture three cannot upload yet is left to its first frame)
      await whenIdle(quietMs);
      if (!live()) return false;
      if (current(t)) break;
      if (t instanceof THREE.DataArrayTexture) {
        const l = (t.userData.layersUp as number | undefined) ?? 0, step = Math.ceil(depth / 8);
        for (let k = l; k < Math.min(depth, l + step); k++) t.addLayerUpdate(k);
        t.userData.layersUp = l + step;
        gl.initTexture(t);
        if (l + step < depth) t.needsUpdate = true;
      } else if (quietMs > 0 && t.image instanceof ImageBitmap && t.image.width * t.image.height >= 1 << 23) {
        // 4k maps (0.3-0.8 s each): allocated empty, then filled in eight strips, one per pause (quietMs 0, behind the
        // boot screen: whole, it is faster)
        const img = t.image, src = new THREE.Texture(img as unknown as HTMLImageElement), h = img.height / 8;
        t.source.dataReady = false; gl.initTexture(t); t.source.dataReady = true;
        for (let y = 0; y < img.height; y += h) {
          if (y) await whenIdle(quietMs);
          if (!live()) { t.needsUpdate = true; return false; } // left half-filled: upload it whole at its first use
          gl.copyTextureToTexture(src, t, new THREE.Box2(new THREE.Vector2(0, y), new THREE.Vector2(img.width, y + h)), new THREE.Vector2(0, y));
        }
      } else gl.initTexture(t);
    }
  }
  return live();
}

/**
 * First draw of every material of a scene, one per pause of the user's input, each clipped to one screen pixel with
 * the rest of the scene hidden: Direct3D compiles a shader only at its first draw (0.2-0.6 s each on an integrated
 * GPU), and one frame doing them all froze the page for ~2 s. Draws on screen, where the real frames go: a render
 * target would build other shader variants. Resolves false if `live()` turned false meanwhile.
 */
export async function drawEachOnce(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, live: () => boolean) {
  const all: THREE.Mesh[] = [], seen = new Set<THREE.Material>();
  scene.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) all.push(m);
  });
  const firsts = all.filter((m) => { const k = Array.isArray(m.material) ? m.material[0] : m.material; return !seen.has(k) && !!seen.add(k); });
  const sc = gl.getScissor(new THREE.Vector4()), st = gl.getScissorTest(), auto = gl.shadowMap.autoUpdate;
  await gl.compileAsync(scene, camera).catch(() => undefined); // what mounted since the first compile (the far field)
  for (const one of firsts) {
    await whenIdle();
    if (!live()) return false;
    for (const m of all) m.visible = m === one;
    const need = gl.shadowMap.needsUpdate;
    gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = false; // no shadow pass for these
    gl.setRenderTarget(null); gl.setScissorTest(true); gl.setScissor(0, 0, 1, 1);
    gl.render(scene, camera);
    gl.setScissor(sc); gl.setScissorTest(st); gl.shadowMap.autoUpdate = auto; gl.shadowMap.needsUpdate = need;
    for (const m of all) m.visible = true;
  }
  return live();
}

/**
 * A very large map (4096^2: ~1.1 s as one upload) decoded off the main thread and sent to the GPU in horizontal strips,
 * one per pause of the user's input (`quietMs` 0: whenever the browser is idle). Mipmaps are rebuilt on the GPU after
 * each strip.
 */
export async function stripedTexture(gl: THREE.WebGLRenderer, url: string, strips = 8, quietMs = 1200) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const src = new THREE.Texture(bmp as unknown as HTMLImageElement);
  const dst = new THREE.DataTexture(null, bmp.width, bmp.height);
  dst.source.dataReady = false; // allocate on the GPU, upload nothing
  dst.generateMipmaps = true;
  dst.minFilter = THREE.LinearMipmapLinearFilter;
  dst.magFilter = THREE.LinearFilter;
  dst.needsUpdate = true;
  const h = Math.ceil(bmp.height / strips);
  for (let y = 0; y < bmp.height; y += h) {
    await whenIdle(quietMs);
    const box = new THREE.Box2(new THREE.Vector2(0, y), new THREE.Vector2(bmp.width, Math.min(bmp.height, y + h)));
    gl.copyTextureToTexture(src, dst, box, new THREE.Vector2(0, y));
  }
  bmp.close();
  return dst;
}
