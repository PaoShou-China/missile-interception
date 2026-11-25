import * as THREE from "three";

/**
 * Streams Web-Mercator satellite tiles into one canvas texture that the ground
 * shader samples in scene space. The texture stays centred on the vehicle, so
 * the ground scrolls underneath while the recorded latitude/longitude advances.
 *
 * Google's satellite tile endpoint is the primary source; ArcGIS World Imagery
 * is used automatically if a tile fails.
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
  private provider: Provider = "google";
  private images = new Map<string, HTMLImageElement>();
  private failed = new Set<string>();
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
    // Uploading a 2048² canvas costs a full copy; building mipmaps on top of
    // that every time a tile lands is what made playback hitch.
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = 1;
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

    if (!Number.isFinite(this.blockX) || Math.abs(bx - this.blockX) > 2 || Math.abs(by - this.blockY) > 2) {
      this.blockX = bx;
      this.blockY = by;
      this.redraw();
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

  private redraw() {
    const cell = this.size / this.grid;
    for (let gy = 0; gy < this.grid; gy++) {
      for (let gx = 0; gx < this.grid; gx++) {
        const tx = this.blockX + gx;
        const ty = this.blockY + gy;
        const key = `${this.zoom}/${tx}/${ty}`;
        const img = this.images.get(key);
        if (img) {
          this.ctx.drawImage(img, gx * cell, gy * cell, cell, cell);
          continue;
        }
        // Leave the previous block's pixels in place until the new tile lands;
        // the shader fades the map out well before the canvas edge.
        this.loadTile(key, tx, ty, gx, gy, cell);
      }
    }
    this.drawn += 1;
    this.dirty = true;
  }

  private loadTile(key: string, tx: number, ty: number, gx: number, gy: number, cell: number) {
    const wrappedX = ((tx % 2 ** this.zoom) + 2 ** this.zoom) % 2 ** this.zoom;
    const hinted = `${key}:${this.provider}`;
    if (this.failed.has(hinted)) return;
    const url = tileUrl(this.provider, this.zoom, wrappedX, ty);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      if (this.disposed) return;
      this.images.set(key, img);
      this.ctx.drawImage(img, gx * cell, gy * cell, cell, cell);
      this.drawn += 1;
      this.dirty = true;
    };
    img.onerror = () => {
      if (this.disposed) return;
      this.failed.add(hinted);
      if (this.provider === "google") {
        this.provider = "esri";
        this.loadTile(key, tx, ty, gx, gy, cell);
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
