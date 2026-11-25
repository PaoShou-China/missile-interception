import * as THREE from "three";

/**
 * Streams Web-Mercator satellite tiles into one canvas texture that the ground
 * shader samples in scene space. The texture stays centred on the vehicle, so
 * the ground scrolls underneath while the recorded latitude/longitude advances.
 *
 * ArcGIS World Imagery is the primary source because its public tile service is
 * intended for this kind of reference use; Google's satellite endpoint remains
 * as a fallback if a tile fails.
 */
const WORLD_METERS = 40075016.686;

export interface MapFrame {
  originU: number;
  originV: number;
  spanMeters: number;
  ready: boolean;
  farU: number;
  farV: number;
}

type Provider = "google" | "esri";

function tileUrl(provider: Provider, z: number, x: number, y: number): string {
  if (provider === "esri") {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  }
  const host = (x + y) % 4;
  return `https://mt${host}.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`;
}

function mercator(latDeg: number, lonDeg: number) {
  const lat = THREE.MathUtils.clamp(latDeg, -85, 85) * (Math.PI / 180);
  const x = ((lonDeg + 180) / 360) * WORLD_METERS;
  const y = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * WORLD_METERS;
  return { x, y };
}

export class MapTileTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readonly size: number;
  private readonly grid: number;
  private readonly zoom: number;
  private readonly span: number;
  private blockX = Number.NaN;
  private blockY = Number.NaN;
  private provider: Provider = "esri";
  private images = new Map<string, HTMLImageElement>();
  private loading = new Set<string>();
  private failed = new Set<string>();
  private pending: { x0: number; y0: number; started: number } | null = null;
  private drawn = 0;
  private dirty = false;
  private disposed = false;

  constructor(size = 2048, grid = 8, zoom = 10) {
    this.size = size;
    this.grid = grid;
    this.zoom = zoom;
    this.span = (WORLD_METERS / 2 ** zoom) * grid;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    // Mipmaps are needed: without them the satellite ground shimmers badly at
    // grazing angles. Uploads are batched by flush(), so the rebuild cost is
    // paid once per window instead of once per tile.
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    // Grazing views of a 626 km tile block need anisotropic filtering, otherwise
    // the ground smears into horizontal streaks that shimmer while scrolling.
    this.texture.anisotropy = 8;
  }

  /** Copies pending canvas changes to the GPU at most once per call. */
  flush(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    this.texture.needsUpdate = true;
    return true;
  }

  get spanMeters() {
    return this.span;
  }

  /** Re-centres the tile block if needed and returns the shader frame. */
  update(latDeg: number, lonDeg: number): MapFrame {
    const { x, y } = mercator(latDeg, lonDeg);
    const tile = WORLD_METERS / 2 ** this.zoom;
    const px = x / tile;
    const py = y / tile;
    const half = this.grid / 2;
    const bx = Math.floor(px) - half;
    const by = Math.floor(py) - half;

    if (!Number.isFinite(this.blockX)) {
      this.blockX = bx;
      this.blockY = by;
      this.redraw();
    } else if (!this.pending && (Math.abs(bx - this.blockX) > 2 || Math.abs(by - this.blockY) > 2)) {
      // Prefetch the next block before switching, so a block change never
      // flashes mismatched or blank tiles over the ground.
      this.pending = { x0: bx, y0: by, started: performance.now() };
      this.prefetch(this.pending);
    }

    if (this.pending) {
      const total = this.grid * this.grid;
      const ready = this.countReady(this.pending);
      const elapsed = performance.now() - this.pending.started;
      if (ready >= total * 0.85 || elapsed > 900) {
        this.blockX = this.pending.x0;
        this.blockY = this.pending.y0;
        this.pending = null;
        this.redraw();
      }
    }

    return {
      originU: (px - this.blockX) / this.grid,
      originV: (py - this.blockY) / this.grid,
      spanMeters: this.span,
      ready: this.drawn > 0,
      farU: (x / 520_000) % 1,
      farV: (y / 520_000) % 1,
    };
  }

  private countReady(block: { x0: number; y0: number }) {
    let n = 0;
    for (let gy = 0; gy < this.grid; gy++) {
      for (let gx = 0; gx < this.grid; gx++) {
        if (this.images.has(`${this.zoom}/${block.x0 + gx}/${block.y0 + gy}`)) n++;
      }
    }
    return n;
  }

  private prefetch(block: { x0: number; y0: number }) {
    for (let gy = 0; gy < this.grid; gy++) {
      for (let gx = 0; gx < this.grid; gx++) {
        this.loadTile(block.x0 + gx, block.y0 + gy);
      }
    }
  }

  private redraw() {
    const cell = this.size / this.grid;
    for (let gy = 0; gy < this.grid; gy++) {
      for (let gx = 0; gx < this.grid; gx++) {
        const tx = this.blockX + gx;
        const ty = this.blockY + gy;
        const img = this.images.get(`${this.zoom}/${tx}/${ty}`);
        if (img) {
          this.ctx.drawImage(img, gx * cell, gy * cell, cell, cell);
        } else {
          this.loadTile(tx, ty);
        }
      }
    }
    this.drawn += 1;
    this.dirty = true;
  }

  private loadTile(tx: number, ty: number) {
    const key = `${this.zoom}/${tx}/${ty}`;
    if (this.images.has(key) || this.loading.has(key) || this.failed.has(`${key}:${this.provider}`)) return;
    const wrappedX = ((tx % 2 ** this.zoom) + 2 ** this.zoom) % 2 ** this.zoom;
    const url = tileUrl(this.provider, this.zoom, wrappedX, ty);
    this.loading.add(key);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      this.loading.delete(key);
      if (this.disposed) return;
      this.images.set(key, img);
      const gx = tx - this.blockX;
      const gy = ty - this.blockY;
      if (gx >= 0 && gx < this.grid && gy >= 0 && gy < this.grid) {
        const cell = this.size / this.grid;
        this.ctx.drawImage(img, gx * cell, gy * cell, cell, cell);
        this.dirty = true;
      }
    };
    img.onerror = () => {
      this.loading.delete(key);
      if (this.disposed) return;
      this.failed.add(`${key}:${this.provider}`);
      if (this.provider === "esri") {
        this.provider = "google";
        this.loadTile(tx, ty);
      }
    };
    img.src = url;
  }

  dispose() {
    this.disposed = true;
    this.texture.dispose();
    this.images.clear();
  }
}
