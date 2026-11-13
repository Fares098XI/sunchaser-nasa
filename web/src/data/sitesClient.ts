import { useSyncExternalStore } from "react";
import type { SiteEntry, SitesManifest } from "../engine/sites";

/** Loads the site catalog once and talks to the windows worker with promise-based requests. */
export class SitesClient {
  manifest!: SitesManifest;
  private worker = new Worker(new URL("../workers/windows.worker.ts", import.meta.url), { type: "module" });
  private next = 1;
  private pending = new Map<number, (v: any) => void>();
  ready: Promise<void>;
  /** bumps when a site is added or removed (S5 pins): views re-query the worker */
  rev = 0;
  private subs = new Set<() => void>();

  constructor(base = "/data/sites/") {
    this.worker.onmessage = (e) => {
      const cb = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      cb?.(e.data);
    };
    this.ready = (async () => {
      this.manifest = await (await fetch(base + "manifest.json")).json();
      const [dsn, ...bufs] = await Promise.all([
        fetch(base + this.manifest.dsn.file).then((r) => r.arrayBuffer()),
        ...this.manifest.sites.map((s) => fetch(base + s.file).then((r) => r.arrayBuffer())),
      ]);
      const files = Object.fromEntries(this.manifest.sites.map((s, i) => [s.id, bufs[i]]));
      const r = await this.call({ type: "init", manifest: this.manifest, dsn, files }, [dsn, ...bufs]);
      if (r.error) throw new Error(r.error);
    })();
  }

  call(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (v) => (v.error ? reject(new Error(v.error)) : resolve(v)));
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** A site computed in the browser (S5 pin): horizons k [az][pt][z] in manifest quantum steps; replaces one with the same id. */
  async addSite(entry: SiteEntry, k: Int16Array) {
    await this.ready;
    const r = await this.call({ type: "add", entry, k }, [k.buffer]);
    if (r.error) throw new Error(r.error);
    this.manifest.sites = [...this.manifest.sites.filter((s) => s.id !== entry.id), entry];
    this.changed();
  }

  async removeSite(id: string) {
    await this.ready;
    if (!this.manifest.sites.some((s) => s.id === id)) return;
    await this.call({ type: "remove", site: id });
    this.manifest.sites = this.manifest.sites.filter((s) => s.id !== id);
    this.changed();
  }

  subscribe(f: () => void) { this.subs.add(f); return () => { this.subs.delete(f); }; }
  private changed() { this.rev++; this.subs.forEach((f) => f()); }

  /** Step index of a UTC ISO time, clamped to the table. */
  stepAt(isoUtc: string): number {
    const i = Math.round((Date.parse(isoUtc) - Date.parse(this.manifest.start_utc + "Z")) / (this.manifest.step_s * 1000));
    return Math.max(0, Math.min(this.manifest.n - 1, i));
  }

  timeAt(step: number): Date {
    return new Date(Date.parse(this.manifest.start_utc + "Z") + step * this.manifest.step_s * 1000);
  }
}

let client: SitesClient | null = null;
export const sitesClient = () => (client ??= new SitesClient());
/** Re-render when sites are added or removed; returns the revision (use it as an effect dependency). */
export const useSitesRev = () => { const c = sitesClient(); return useSyncExternalStore((f) => c.subscribe(f), () => c.rev); };
