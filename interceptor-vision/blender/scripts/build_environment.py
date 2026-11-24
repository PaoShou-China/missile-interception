"""
Environment asset generator for Interceptor Vision.

Run:
    blender -b -P blender/scripts/build_environment.py

Outputs (public/assets):
    terrain-day.jpg          tiling terrain colour map (2K)
    terrain-normal.jpg       matching normal map
    cloud-a.png, cloud-b.png fractal cloud alpha sheets
    env-day.hdr              equirectangular HDRI, midday
    env-dusk.hdr             equirectangular HDRI, sunset
    env-night.hdr            equirectangular HDRI, moonless night

The HDRIs are rendered with Cycles from a Nishita sky and written as Radiance
RGBE so Three.js can load them with RGBELoader.
"""

from __future__ import annotations

import math
import time
from pathlib import Path

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "assets"
BLEND_OUT = ROOT / "blender" / "environment.blend"
OUT.mkdir(parents=True, exist_ok=True)


# ----------------------------------------------------------------------------
# numpy helpers
# ----------------------------------------------------------------------------

def value_noise(shape: tuple[int, int], cells: int, seed: int) -> np.ndarray:
    """Periodic, tileable bilinear value noise."""
    rng = np.random.default_rng(seed)
    grid = rng.random((cells, cells)).astype(np.float32)
    ys = np.linspace(0, cells, shape[0], endpoint=False)
    xs = np.linspace(0, cells, shape[1], endpoint=False)
    y0 = ys.astype(int) % cells
    x0 = xs.astype(int) % cells
    y1 = (y0 + 1) % cells
    x1 = (x0 + 1) % cells
    fy = (ys - np.floor(ys))[:, None]
    fx = (xs - np.floor(xs))[None, :]
    fy = fy * fy * (3 - 2 * fy)
    fx = fx * fx * (3 - 2 * fx)
    a = grid[np.ix_(y0, x0)]
    b = grid[np.ix_(y0, x1)]
    c = grid[np.ix_(y1, x0)]
    d = grid[np.ix_(y1, x1)]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(shape: tuple[int, int], base_cells: int, octaves: int, seed: int) -> np.ndarray:
    total = np.zeros(shape, dtype=np.float32)
    amp, norm = 1.0, 0.0
    cells = base_cells
    for i in range(octaves):
        total += value_noise(shape, cells, seed + i * 31) * amp
        norm += amp
        amp *= 0.5
        cells = min(cells * 2, min(shape))
    return total / norm


def write_image(name: str, rgba: np.ndarray, path: Path, fmt: str = "PNG") -> None:
    h, w = rgba.shape[:2]
    img = bpy.data.images.new(name, width=w, height=h, alpha=True)
    img.pixels.foreach_set(rgba[::-1].ravel().astype(np.float32))
    img.filepath_raw = str(path)
    img.file_format = fmt
    img.save()
    print("wrote", path, f"{path.stat().st_size / 1e6:.2f} MB")


# ----------------------------------------------------------------------------
# Terrain and clouds
# ----------------------------------------------------------------------------

def build_terrain(size: int = 2048) -> None:
    t0 = time.time()
    shape = (size, size)
    h = fbm(shape, 3, 7, 11)
    ridge = 1.0 - np.abs(fbm(shape, 5, 5, 71) * 2.0 - 1.0)
    h = h * 0.72 + ridge * 0.28
    h = (h - h.min()) / (h.max() - h.min())

    sea = 0.47
    detail = fbm(shape, 32, 4, 203)
    h = h + (detail - 0.5) * 0.04

    deep = np.array([0.016, 0.075, 0.13], dtype=np.float32)
    shallow = np.array([0.05, 0.22, 0.31], dtype=np.float32)
    beach = np.array([0.62, 0.56, 0.4], dtype=np.float32)
    plain = np.array([0.29, 0.36, 0.2], dtype=np.float32)
    forest = np.array([0.16, 0.26, 0.16], dtype=np.float32)
    rock = np.array([0.42, 0.39, 0.35], dtype=np.float32)
    snow = np.array([0.86, 0.89, 0.92], dtype=np.float32)

    ocean_t = np.clip((h - 0.2) / (sea - 0.2), 0, 1)[..., None]
    col = deep * (1 - ocean_t) + shallow * ocean_t

    land = np.zeros((size, size, 3), dtype=np.float32)
    t = np.clip((h - sea) / (1 - sea), 0, 1)[..., None]
    veg = fbm(shape, 20, 3, 909)[..., None]
    low = forest * (1 - veg) + plain * veg
    mid = low * (1 - t) + rock * t
    high = mid * (1 - np.clip((t - 0.55) / 0.25, 0, 1)) + snow * np.clip((t - 0.55) / 0.25, 0, 1)
    land = high
    land = land * (1 - np.clip((0.5 - t) / 0.04, 0, 1)) + beach * np.clip((0.5 - t) / 0.04, 0, 1)

    mask = (h > sea).astype(np.float32)[..., None]
    col = col * (1 - mask) + land * mask

    # Sparse shallows / reefs just off the coast.
    shallow_mask = ((h > sea - 0.012) & (h <= sea)).astype(np.float32)[..., None]
    col = col * (1 - shallow_mask * 0.5) + np.array([0.1, 0.4, 0.42], dtype=np.float32) * shallow_mask * 0.5

    rgba = np.concatenate([np.clip(col, 0, 1), np.ones((size, size, 1), dtype=np.float32)], axis=-1)
    write_image("terrain-day", rgba, OUT / "terrain-day.jpg", "JPEG")

    gy, gx = np.gradient(h)
    strength = 22.0
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack([nx / ln * 0.5 + 0.5, ny / ln * 0.5 + 0.5, nz / ln * 0.5 + 0.5, np.ones_like(h)], axis=-1)
    write_image("terrain-normal", normal, OUT / "terrain-normal.jpg", "JPEG")
    print(f"terrain done in {time.time() - t0:.1f}s")


def build_clouds(size: int = 1024) -> None:
    shape = (size, size)
    for name, seed, coverage in (("cloud-a", 5, 0.5), ("cloud-b", 19, 0.56)):
        n = fbm(shape, 4, 7, seed)
        n = (n - n.min()) / (n.max() - n.min())
        wisps = fbm(shape, 16, 4, seed + 3)
        n = n * 0.82 + wisps * 0.18
        alpha = np.clip((n - coverage) / 0.24, 0, 1) ** 1.35
        shade = 0.82 + 0.18 * np.clip((n - coverage) / 0.4, 0, 1)
        rgb = np.stack([shade, shade, shade * 1.02], axis=-1)
        rgba = np.concatenate([rgb, alpha[..., None]], axis=-1)
        write_image(name, rgba, OUT / f"{name}.png")


# ----------------------------------------------------------------------------
# HDRI skies
# ----------------------------------------------------------------------------

def setup_sky_render(sun_elevation: float, sun_rotation: float, strength: float, name: str) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    world = bpy.data.worlds.new(f"Sky-{name}")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA"
    sky.sun_elevation = math.radians(sun_elevation)
    sky.sun_rotation = math.radians(sun_rotation)
    sky.sun_intensity = 0.9
    sky.air_density = 1.2
    sky.dust_density = 1.8
    if name == "night":
        sky.sun_intensity = 0.0
        bg.inputs["Color"].default_value = (0.004, 0.006, 0.012, 1)
        bg.inputs["Strength"].default_value = strength
    else:
        nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world

    cam_data = bpy.data.cameras.new(f"Pano-{name}")
    cam_data.type = "PANO"
    cam_data.panorama_type = "EQUIRECTANGULAR"
    cam = bpy.data.objects.new(f"Pano-{name}", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = (0, 0, 0)
    scene.camera = cam


def exr_to_hdr(exr_path: Path, hdr_path: Path) -> None:
    img = bpy.data.images.load(str(exr_path))
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)  # bottom-up rows
    rgb = np.clip(px[..., :3], 0, None)[::-1]  # top-down for the HDR scanline order

    lum = rgb.max(axis=-1)
    exp = np.zeros_like(lum, dtype=np.uint8)
    mant = np.zeros_like(rgb, dtype=np.uint8)
    nz = lum > 1e-32
    frexp_m, frexp_e = np.frexp(lum[nz])
    scale = frexp_m * 256.0 / lum[nz]
    mant[nz] = np.clip(rgb[nz] * scale[..., None], 0, 255).astype(np.uint8)
    exp[nz] = np.clip(frexp_e + 128, 0, 255).astype(np.uint8)
    rgbe = np.concatenate([mant, exp[..., None]], axis=-1)

    header = f"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y {h} +X {w}\n".encode("ascii")
    hdr_path.write_bytes(header + rgbe.tobytes())
    bpy.data.images.remove(img)
    print("wrote", hdr_path, f"{hdr_path.stat().st_size / 1e6:.2f} MB")


def build_hdris() -> None:
    specs = [
        ("day", 42.0, 150.0, 0.55),
        ("dusk", 3.0, 110.0, 0.6),
        ("night", -18.0, 0.0, 1.0),
    ]
    for name, elev, rot, strength in specs:
        setup_sky_render(elev, rot, strength, name)
        exr = OUT / f"env-{name}.exr"
        bpy.context.scene.render.image_settings.file_format = "OPEN_EXR"
        bpy.context.scene.render.image_settings.color_depth = "32"
        bpy.context.scene.render.filepath = str(exr)
        bpy.ops.render.render(write_still=True)
        exr_to_hdr(exr, OUT / f"env-{name}.hdr")
        exr.unlink(missing_ok=True)


def main() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    build_terrain()
    build_clouds()
    build_hdris()
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_OUT))
    print("saved", BLEND_OUT)


if __name__ == "__main__":
    main()
