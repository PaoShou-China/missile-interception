"""
Procedural long-range interceptor modelled on the published SM-3 Block IB/IIA
profile: pointed nosecone, long slender airframe with harness strakes, four
tail control surfaces ahead of a wider MK72-style booster stage.

Run:
    blender -b -P blender/scripts/build_missile.py

Outputs:
    blender/interceptor.blend
    public/assets/interceptor-lod0.glb
    public/assets/interceptor-lod1.glb
    public/assets/interceptor-lod2.glb
    public/assets/panel-normal.png / panel-rough.png  (embedded into the GLB)

Blender axes: +X nose, +Z up. The glTF exporter turns this into +X nose,
+Y up, which is what the web scene assumes.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "public" / "assets"
BLEND_OUT = ROOT / "blender" / "interceptor.blend"

ASSETS.mkdir(parents=True, exist_ok=True)
BLEND_OUT.parent.mkdir(parents=True, exist_ok=True)

SEGMENTS = 72
BODY_X_MIN, BODY_X_MAX = -2.30, 3.52


# ----------------------------------------------------------------------------
# Scene helpers
# ----------------------------------------------------------------------------

def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def make_mesh(
    name: str,
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    mat: bpy.types.Material,
    smooth: bool = True,
) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    if smooth:
        for poly in me.polygons:
            poly.use_smooth = True
    return obj


def principled(mat: bpy.types.Material):
    return mat.node_tree.nodes.get("Principled BSDF")


def material(
    name: str,
    base: tuple[float, float, float],
    metallic: float = 0.0,
    roughness: float = 0.4,
    coat: float = 0.0,
    emission: tuple[float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = principled(mat)
    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    for key in ("Coat Weight", "Clearcoat"):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = coat
            break
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


# ----------------------------------------------------------------------------
# Surface textures (panel lines + roughness variation)
# ----------------------------------------------------------------------------

def value_noise(shape: tuple[int, int], cells: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    grid = rng.random((cells + 1, cells + 1)).astype(np.float32)
    ys = np.linspace(0, cells, shape[0], endpoint=False)
    xs = np.linspace(0, cells, shape[1], endpoint=False)
    y0 = ys.astype(int)
    x0 = xs.astype(int)
    fy = (ys - y0)[:, None]
    fx = (xs - x0)[None, :]
    fy = fy * fy * (3 - 2 * fy)
    fx = fx * fx * (3 - 2 * fx)
    a = grid[np.ix_(y0, x0)]
    b = grid[np.ix_(y0, x0 + 1)]
    c = grid[np.ix_(y0 + 1, x0)]
    d = grid[np.ix_(y0 + 1, x0 + 1)]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def build_panel_textures() -> tuple[bpy.types.Image, bpy.types.Image]:
    h, w = 512, 1024
    yy, xx = np.mgrid[0:h, 0:w]
    u = xx / w
    v = yy / h

    height = np.zeros((h, w), dtype=np.float32)
    for cells, amp in ((8, 0.5), (16, 0.25), (48, 0.15), (128, 0.1)):
        height += value_noise((h, w), cells, cells * 7) * amp

    # Longitudinal panel seams (u) and circumferential frames (v).
    for u0 in (0.16, 0.34, 0.5, 0.66, 0.84):
        height -= 0.55 * np.exp(-((u - u0) ** 2) / (2 * 0.0016**2))
    for v0 in (0.12, 0.26, 0.4, 0.55, 0.68, 0.8, 0.9):
        height -= 0.5 * np.exp(-((v - v0) ** 2) / (2 * 0.0011**2))

    # Fine hatch lines in a few panels.
    height += 0.05 * np.sin(v * 900) * (u > 0.5) * (u < 0.66)

    gy, gx = np.gradient(height)
    strength = 2.6
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(height)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny, nz = nx / ln, ny / ln, nz / ln

    normal = np.stack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5], axis=-1)
    rough = np.clip(0.34 + 0.22 * (0.5 - height) + 0.05 * value_noise((h, w), 64, 9), 0.2, 0.65)

    normal_img = bpy.data.images.new("panel-normal", width=w, height=h, alpha=False)
    flat = np.concatenate([normal[::-1], np.ones((h, w, 1), dtype=np.float32)], axis=-1).ravel()
    normal_img.pixels.foreach_set(flat.astype(np.float32))
    normal_img.filepath_raw = str(ASSETS / "panel-normal.png")
    normal_img.file_format = "PNG"
    normal_img.save()

    rough_img = bpy.data.images.new("panel-rough", width=w, height=h, alpha=False)
    rgba = np.stack([rough[::-1], rough[::-1], rough[::-1], np.ones_like(rough)], axis=-1)
    rough_img.pixels.foreach_set(rgba.ravel().astype(np.float32))
    rough_img.filepath_raw = str(ASSETS / "panel-rough.png")
    rough_img.file_format = "PNG"
    rough_img.save()
    return normal_img, rough_img


def textured_body_material(normal_img, rough_img) -> bpy.types.Material:
    mat = material("MAT_Body", (0.86, 0.89, 0.92), 0.35, 0.34, coat=0.35)
    nt = mat.node_tree
    bsdf = principled(mat)
    normal_tex = nt.nodes.new("ShaderNodeTexImage")
    normal_tex.image = normal_img
    normal_tex.image.colorspace_settings.name = "Non-Color"
    normal_tex.location = (-680, 120)
    normal_map = nt.nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = 0.45
    normal_map.location = (-380, 120)
    nt.links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    nt.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    rough_tex = nt.nodes.new("ShaderNodeTexImage")
    rough_tex.image = rough_img
    rough_tex.image.colorspace_settings.name = "Non-Color"
    rough_tex.location = (-680, -220)
    nt.links.new(rough_tex.outputs["Color"], bsdf.inputs["Roughness"])
    return mat


# ----------------------------------------------------------------------------
# Body
# ----------------------------------------------------------------------------

BODY_PROFILE = [
    (3.52, 0.012), (3.38, 0.040), (3.18, 0.078), (2.98, 0.118),
    (2.78, 0.146), (2.58, 0.162), (2.38, 0.170), (2.10, 0.170),
    (-1.60, 0.170), (-2.10, 0.170), (-2.30, 0.166),
]


def body_radius_at(x: float) -> float:
    pts = BODY_PROFILE
    for i in range(len(pts) - 1):
        x0, r0 = pts[i]
        x1, r1 = pts[i + 1]
        if x1 <= x <= x0:
            t = (x - x0) / (x1 - x0) if x1 != x0 else 0.0
            return r0 + (r1 - r0) * t
    return 0.0


def build_body(mat: bpy.types.Material) -> bpy.types.Object:
    stations = 150
    verts: list[tuple[float, float, float]] = []
    for i in range(stations):
        t = i / (stations - 1)
        # cosine spacing: denser rings at the nose tip and boattail
        x = BODY_X_MAX - (BODY_X_MAX - BODY_X_MIN) * (0.5 - 0.5 * math.cos(math.pi * t))
        r = max(0.006, body_radius_at(x))
        for j in range(SEGMENTS):
            a = 2.0 * math.pi * j / SEGMENTS
            verts.append((x, r * math.cos(a), r * math.sin(a)))
    verts.append((BODY_X_MAX + 0.02, 0.0, 0.0))
    verts.append((BODY_X_MIN - 0.01, 0.0, 0.0))
    nose, tail = len(verts) - 2, len(verts) - 1

    faces: list[tuple[int, ...]] = []
    for s in range(stations - 1):
        a0, b0 = s * SEGMENTS, (s + 1) * SEGMENTS
        for j in range(SEGMENTS):
            j2 = (j + 1) % SEGMENTS
            faces.append((a0 + j, a0 + j2, b0 + j2, b0 + j))
    for j in range(SEGMENTS):
        j2 = (j + 1) % SEGMENTS
        faces.append((nose, j, j2))
        base = (stations - 1) * SEGMENTS
        faces.append((tail, base + j2, base + j))

    obj = make_mesh("Body", verts, faces, mat)

    # Cylindrical UVs drive the panel-line maps.
    uvl = obj.data.uv_layers.new(name="UVMap")
    for poly in obj.data.polygons:
        for li in poly.loop_indices:
            vi = obj.data.loops[li].vertex_index
            x, y, z = verts[vi]
            u = (math.atan2(z, y) / (2 * math.pi)) % 1.0
            v = (x - BODY_X_MIN) / (BODY_X_MAX - BODY_X_MIN)
            uvl.data[li].uv = (u, v)
    return obj


# ----------------------------------------------------------------------------
# Aerodynamic surfaces
# ----------------------------------------------------------------------------

def extrude_shape(name: str, points: list[tuple[float, float]], depth: float, mat: bpy.types.Material):
    """Extrude an XY polygon along Z, centred on the plane."""
    verts = [(x, y, -depth / 2) for x, y in points] + [(x, y, depth / 2) for x, y in points]
    n = len(points)
    faces: list[tuple[int, ...]] = []
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    obj = make_mesh(name, verts, faces, mat, smooth=False)
    # A small bevel catches highlights and stops the fins reading as paper.
    mod = obj.modifiers.new("EdgeBevel", "BEVEL")
    mod.width = min(0.0025, depth * 0.22)
    mod.segments = 2
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(40)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def build_strakes(mat: bpy.types.Material) -> list[bpy.types.Object]:
    # Long harness strakes with a visible swept lifting surface.
    points = [(1.60, 0.13), (-1.60, 0.13), (-1.20, 0.34), (0.55, 0.40)]
    out = []
    for side in (1, -1):
        pts = [(x, y * side) for x, y in points]
        if side < 0:  # keep the winding consistent so normals face outward
            pts = pts[::-1]
        out.append(extrude_shape(f"Strake_{'L' if side > 0 else 'R'}", pts, 0.020, mat))
    return out


TAIL_POINTS = [(0.0, 0.0), (-0.62, 0.06), (-0.56, 0.40), (-0.02, 0.44)]


def build_tail_fins(mat: bpy.types.Material) -> list[bpy.types.Object]:
    out = []
    for i, ang in enumerate((0.0, math.pi / 2, math.pi, 3 * math.pi / 2)):
        pts = [(x, y + 0.166) for x, y in TAIL_POINTS]
        fin = extrude_shape(f"TailFin_{i}", pts, 0.028, mat)
        fin.location = (-1.95, 0.0, 0.0)
        fin.rotation_euler[0] = -ang
        out.append(fin)
    return out


def build_booster(mat: bpy.types.Material) -> bpy.types.Object:
    """MK72-style booster stage: slightly wider, olive-grey, tapered aft."""
    booster = revolve(
        "Booster",
        [
            (-2.26, 0.170), (-2.30, 0.196), (-2.38, 0.205),
            (-2.95, 0.205), (-3.08, 0.205), (-3.16, 0.198),
            (-3.22, 0.185), (-3.24, 0.170),
        ],
        mat,
        56,
    )
    return booster


def revolve(name: str, profile: list[tuple[float, float]], mat: bpy.types.Material, segments: int = 48):
    verts = []
    for x, r in profile:
        for i in range(segments):
            a = 2.0 * math.pi * i / segments
            verts.append((x, r * math.cos(a), r * math.sin(a)))
    faces = []
    for s in range(len(profile) - 1):
        a0, b0 = s * segments, (s + 1) * segments
        for j in range(segments):
            j2 = (j + 1) % segments
            faces.append((a0 + j, a0 + j2, b0 + j2, b0 + j))
    return make_mesh(name, verts, faces, mat)


def torus(name, x: float, major: float, minor: float, mat) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor, major_segments=64, minor_segments=10,
        location=(x, 0, 0), rotation=(0, math.pi / 2, 0),
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


# ----------------------------------------------------------------------------
# Details
# ----------------------------------------------------------------------------

def build_details(mats: dict) -> list[bpy.types.Object]:
    objs: list[bpy.types.Object] = []

    # Seeker window: a dark dielectric cone set into the ogive.
    seeker = revolve(
        "Seeker",
        [(3.36, 0.008), (3.30, 0.045), (3.22, 0.062), (3.14, 0.070)],
        mats["seeker"],
        48,
    )
    objs.append(seeker)
    lens = revolve(
        "SeekerLens",
        [(3.355, 0.004), (3.33, 0.03), (3.30, 0.045)],
        mats["lens"],
        40,
    )
    objs.append(lens)

    # Body panel rings and the service band / accent stripe.
    for i, x in enumerate((1.25, 1.74, -0.55)):
        objs.append(torus(f"PanelRing_{i}", x, 0.1715, 0.0038, mats["metal"]))
    objs.append(torus("ServiceBand", -1.15, 0.1715, 0.014, mats["band"]))
    objs.append(torus("AccentStripe", 1.95, 0.1718, 0.010, mats["accent"]))

    # Nozzle bell, throat glow and actuator housings.
    nozzle = revolve(
        "Nozzle",
        [(-3.22, 0.176), (-3.30, 0.170), (-3.36, 0.140), (-3.40, 0.110)],
        mats["nozzle"],
        48,
    )
    objs.append(nozzle)
    glow = revolve(
        "NozzleGlow",
        [(-3.30, 0.108), (-3.35, 0.09), (-3.38, 0.06)],
        mats["glow"],
        32,
    )
    objs.append(glow)

    # Booster separation ring, clamp bands and the steering-control section.
    objs.append(torus("SeparationRing", -2.30, 0.198, 0.012, mats["metal"]))
    for i, x in enumerate((-2.55, -2.92)):
        objs.append(torus(f"BoosterBand_{i}", x, 0.207, 0.008, mats["band"]))
    objs.append(torus("SCSRing", -1.95, 0.173, 0.007, mats["metal"]))

    for i, ang in enumerate((0.0, math.pi / 2, math.pi, 3 * math.pi / 2)):
        act = make_mesh(
            f"Actuator_{i}",
            [
                (-1.86, 0.172, -0.018), (-1.56, 0.172, -0.018),
                (-1.56, 0.172, 0.018), (-1.86, 0.172, 0.018),
            ],
            [(0, 1, 2, 3)],
            mats["band"],
            smooth=False,
        )
        act.rotation_euler[0] = ang
        objs.append(act)

    # Small antennas / data-link blades and hatches.
    for x, z in ((0.9, 0.171), (-1.7, 0.171), (2.15, 0.12)):
        blade = make_mesh(
            f"Antenna_{x}",
            [(x, -0.012, z + 0.0), (x - 0.28, -0.008, z), (x - 0.26, 0.0, z + 0.075), (x - 0.03, 0.008, z)],
            [(0, 1, 2, 3)],
            mats["band"],
            smooth=False,
        )
        objs.append(blade)

    for x in (2.55, 0.15, -1.55):
        hatch = make_mesh(
            f"Hatch_{x}",
            [
                (x + 0.16, -0.03, 0.1705), (x - 0.16, -0.03, 0.1705),
                (x - 0.16, 0.03, 0.1705), (x + 0.16, 0.03, 0.1705),
            ],
            [(0, 1, 2, 3)],
            mats["band"],
            smooth=False,
        )
        objs.append(hatch)

    # Umbilical fairing along the belly (a shallow box, not a zero-thickness plane).
    fair = make_mesh(
        "BellyFairing",
        [
            (1.9, -0.05, -0.168), (1.9, 0.05, -0.168),
            (-1.4, 0.05, -0.168), (-1.4, -0.05, -0.168),
            (1.9, -0.05, -0.212), (1.9, 0.05, -0.212),
            (-1.4, 0.05, -0.212), (-1.4, -0.05, -0.212),
        ],
        [
            (0, 1, 2, 3), (4, 7, 6, 5),
            (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0),
        ],
        mats["band"],
        smooth=False,
    )
    objs.append(fair)
    return objs


# ----------------------------------------------------------------------------
# Assembly
# ----------------------------------------------------------------------------

def join_objects(objs: list[bpy.types.Object], name: str) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    return joined


def duplicate_hierarchy(root: bpy.types.Object) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.object.duplicate()
    return bpy.context.view_layer.objects.active


def decimate(obj: bpy.types.Object, ratio: float) -> None:
    mod = obj.modifiers.new("LOD", "DECIMATE")
    mod.ratio = ratio
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)


def export(obj: bpy.types.Object, path: Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    for child in obj.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_image_format="WEBP",
        export_image_quality=90,
    )
    print(f"exported {path} ({path.stat().st_size / 1e6:.2f} MB)")


def main() -> None:
    clear_scene()
    bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    bpy.context.scene.unit_settings.system = "METRIC"

    normal_img, rough_img = build_panel_textures()
    mats = {
        "body": textured_body_material(normal_img, rough_img),
        "fin": material("MAT_Fin", (0.72, 0.76, 0.8), 0.55, 0.32, coat=0.25),
        "booster": material("MAT_Booster", (0.26, 0.24, 0.13), 0.3, 0.55, coat=0.1),
        "metal": material("MAT_Metal", (0.62, 0.66, 0.7), 0.95, 0.24),
        "band": material("MAT_Band", (0.09, 0.11, 0.13), 0.6, 0.38),
        "accent": material("MAT_Accent", (0.12, 0.6, 0.78), 0.5, 0.3, emission=(0.1, 0.5, 0.7), emission_strength=0.25),
        "seeker": material("MAT_Seeker", (0.02, 0.06, 0.1), 0.6, 0.05, coat=1.0),
        "lens": material("MAT_Lens", (0.05, 0.35, 0.5), 0.4, 0.03, coat=1.0, emission=(0.2, 0.75, 0.95), emission_strength=0.5),
        "nozzle": material("MAT_Nozzle", (0.16, 0.17, 0.19), 0.92, 0.32),
        "glow": material("MAT_Glow", (1.0, 0.55, 0.2), 0.0, 0.4, emission=(1.0, 0.5, 0.16), emission_strength=7.0),
    }

    parts: list[bpy.types.Object] = [build_body(mats["body"])]
    parts += build_strakes(mats["fin"])
    parts += build_tail_fins(mats["fin"])
    parts.append(build_booster(mats["booster"]))
    parts += build_details(mats)

    for obj in parts:
        if obj.type == "MESH" and obj.name.startswith(("Body", "TailFin", "Strake", "Booster")):
            try:
                bpy.context.view_layer.objects.active = obj
                bpy.ops.object.select_all(action="DESELECT")
                obj.select_set(True)
                bpy.ops.object.shade_smooth_by_angle(angle=math.radians(42))
            except Exception as exc:  # noqa: BLE001
                print("auto smooth skipped:", exc)

    missile = join_objects(parts, "Missile")
    missile.data.name = "MissileMesh"

    root = bpy.data.objects.new("MissileRoot", None)
    bpy.context.collection.objects.link(root)
    missile.parent = root

    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("PreviewCamera")
    cam = bpy.data.objects.new("PreviewCamera", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = (5.2, -6.4, 2.4)
    cam.rotation_euler = (math.radians(76), 0, math.radians(38))
    cam_data.lens = 55
    scene.camera = cam
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080

    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_OUT))
    print(f"saved {BLEND_OUT}")

    export(root, ASSETS / "interceptor-lod0.glb")

    lod1 = duplicate_hierarchy(root)
    lod1.name = "InterceptorLOD1"
    for child in lod1.children_recursive:
        if child.type == "MESH":
            decimate(child, 0.45)
    export(lod1, ASSETS / "interceptor-lod1.glb")

    lod2 = duplicate_hierarchy(root)
    lod2.name = "InterceptorLOD2"
    for child in lod2.children_recursive:
        if child.type == "MESH":
            decimate(child, 0.16)
    export(lod2, ASSETS / "interceptor-lod2.glb")


if __name__ == "__main__":
    main()
