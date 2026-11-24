"""
Cycles stills for the offline gallery: day/dusk/night × macro/meso/micro.

Run:
    blender -b blender/interceptor.blend -P blender/scripts/render_stills.py

Outputs public/renders/still-<time>-<view>.jpg and manifest.json.
"""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "renders"
ASSETS = ROOT / "public" / "assets"
OUT.mkdir(parents=True, exist_ok=True)

# Web camera poses (Y-up) converted to Blender (Z-up): (x, -z, y).
POSES = {
    "macro": ((24.0, -108.0, 20.0), (0.0, 30.0, -6.0), 46.0),
    "meso": ((7.4, -6.6, 2.3), (0.0, 0.0, -0.05), 34.0),
    "micro": ((5.9, -2.75, 1.15), (2.15, -0.15, 0.3), 34.0),
}

TIMES = {
    "day": {"elev": 46.0, "rot": 150.0, "strength": 0.075, "sun": 2.1, "sun_color": (1.0, 0.95, 0.88), "exp": -0.55},
    "dusk": {"elev": 5.5, "rot": 110.0, "strength": 0.085, "sun": 1.7, "sun_color": (1.0, 0.62, 0.36), "exp": -0.35},
    "night": {"elev": -16.0, "rot": 0.0, "strength": 0.05, "sun": 0.9, "sun_color": (0.55, 0.66, 1.0), "exp": 0.55},
}

LABELS = {
    "zh": {"day": "白天", "dusk": "黄昏", "night": "夜晚", "macro": "宏观", "meso": "中观", "micro": "微观"},
    "en": {"day": "Day", "dusk": "Dusk", "night": "Night", "macro": "Macro", "meso": "Meso", "micro": "Micro"},
}


def clear_extras() -> None:
    for name in ("AnimCam", "Sun", "Moon", "CloudSea", "StarField", "Ground"):
        obj = bpy.data.objects.get(name)
        if obj:
            bpy.data.objects.remove(obj, do_unlink=True)


def make_world(name: str, elev: float, rot: float, strength: float) -> None:
    world = bpy.data.worlds.new(f"World-{name}")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA"
    sky.sun_elevation = math.radians(elev)
    sky.sun_rotation = math.radians(rot)
    sky.sun_intensity = 0.8
    sky.air_density = 1.1
    sky.dust_density = 1.6
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    bpy.context.scene.world = world


def add_sun(preset: dict) -> None:
    data = bpy.data.lights.new("Sun", "SUN")
    data.energy = preset["sun"]
    data.color = preset["sun_color"]
    data.angle = math.radians(0.6)
    obj = bpy.data.objects.new("Sun", data)
    bpy.context.collection.objects.link(obj)
    elev = math.radians(preset["elev"])
    rot = math.radians(preset["rot"])
    obj.rotation_euler = (math.pi / 2 - elev, 0.0, rot)
    obj.location = (0, 0, 3000)


def add_starfield() -> None:
    import random

    rng = random.Random(7)
    stars = []
    for _ in range(260):
        theta = rng.random() * math.tau
        phi = math.acos(1.0 - rng.random() * 0.97)
        r = 300_000.0
        loc = (
            r * math.sin(phi) * math.cos(theta),
            r * math.sin(phi) * math.sin(theta),
            r * math.cos(phi),
        )
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=rng.uniform(90, 220), location=loc)
        stars.append(bpy.context.active_object)

    bpy.ops.object.select_all(action="DESELECT")
    for s in stars:
        s.select_set(True)
    bpy.context.view_layer.objects.active = stars[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = "StarField"
    mat = bpy.data.materials.new("MAT_Stars")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (0.86, 0.91, 1.0, 1)
    emit.inputs["Strength"].default_value = 6.0
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    obj.data.materials.append(mat)
    obj.visible_shadow = False


def add_ground() -> None:
    bpy.ops.mesh.primitive_plane_add(size=3_000_000, location=(0, 0, -30_000))
    plane = bpy.context.active_object
    plane.name = "Ground"
    mat = bpy.data.materials.new("MAT_Ground")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    img = bpy.data.images.load(str(ASSETS / "terrain-day.jpg"))
    node = nt.nodes.new("ShaderNodeTexImage")
    node.image = img
    node.extension = "REPEAT"
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (6.0, 6.0, 1)
    coords = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(coords.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], node.inputs["Vector"])
    nt.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    plane.data.materials.append(mat)
    plane.visible_shadow = False


def add_cloud_sea() -> None:
    scene = bpy.context.scene
    for i, (z, tex, opacity, scale, rot) in enumerate(
        (
            (-12000.0, "cloud-a.png", 0.9, 11.0, 0.35),
            (-20000.0, "cloud-b.png", 0.7, 7.5, 1.15),
        )
    ):
        bpy.ops.mesh.primitive_plane_add(size=2_400_000, location=(0, 0, z), rotation=(0, 0, rot))
        plane = bpy.context.active_object
        plane.name = f"CloudSea-{i}"
        mat = bpy.data.materials.new(f"MAT_CloudSea{i}")
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        tex_node = nt.nodes.new("ShaderNodeTexImage")
        img = bpy.data.images.load(str(ASSETS / tex))
        tex_node.image = img
        tex_node.extension = "REPEAT"
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = (scale, scale, 1)
        coords = nt.nodes.new("ShaderNodeTexCoord")
        nt.links.new(coords.outputs["Generated"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs["Vector"], tex_node.inputs["Vector"])
        # Reduce the diffuse response so cloud tops do not clip to white.
        shade = nt.nodes.new("ShaderNodeMixRGB")
        shade.blend_type = "MULTIPLY"
        shade.inputs["Fac"].default_value = 0.45
        shade.inputs["Color2"].default_value = (0.85, 0.88, 0.92, 1)
        nt.links.new(tex_node.outputs["Color"], shade.inputs["Color1"])
        nt.links.new(shade.outputs["Color"], bsdf.inputs["Base Color"])
        nt.links.new(tex_node.outputs["Alpha"], bsdf.inputs["Alpha"])
        bsdf.inputs["Roughness"].default_value = 1.0
        mat.blend_method = "BLEND"
        plane.data.materials.append(mat)
        plane.visible_shadow = False
        if i == 0:
            plane.scale = (1, 1, 1)


def add_plume() -> None:
    nozzle_x = -3.34
    layers = [
        (0.7, 0.055, (1.0, 0.95, 0.85), 16.0),
        (1.15, 0.085, (1.0, 0.55, 0.22), 6.0),
        (1.6, 0.115, (0.35, 0.7, 1.0), 2.0),
    ]
    for i, (length, radius, color, power) in enumerate(layers):
        bpy.ops.mesh.primitive_cone_add(
            vertices=32, radius1=radius, radius2=0.0, depth=length,
            location=(nozzle_x - length / 2, 0, 0), rotation=(0, -math.pi / 2, 0),
        )
        cone = bpy.context.active_object
        cone.name = f"Plume-{i}"
        mat = bpy.data.materials.new(f"MAT_Plume{i}")
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        emit = nt.nodes.new("ShaderNodeEmission")
        emit.inputs["Color"].default_value = (*color, 1)
        emit.inputs["Strength"].default_value = power
        transparent = nt.nodes.new("ShaderNodeBsdfTransparent")
        mix = nt.nodes.new("ShaderNodeMixShader")
        layer = nt.nodes.new("ShaderNodeLayerWeight")
        layer.inputs["Blend"].default_value = 0.35
        nt.links.new(layer.outputs["Facing"], mix.inputs["Fac"])
        nt.links.new(transparent.outputs["BSDF"], mix.inputs[1])
        nt.links.new(emit.outputs["Emission"], mix.inputs[2])
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
        cone.data.materials.append(mat)
        cone.visible_shadow = False


def setup_camera(pose, fov: float) -> None:
    pos, look, _ = pose
    cam = bpy.data.objects.get("RenderCam")
    if cam is None:
        data = bpy.data.cameras.new("RenderCam")
        cam = bpy.data.objects.new("RenderCam", data)
        bpy.context.collection.objects.link(cam)
    cam.location = pos
    direction = Vector(look) - Vector(pos)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    cam.data.type = "PERSP"
    cam.data.sensor_fit = "VERTICAL"
    cam.data.angle = math.radians(fov)
    cam.data.clip_start = 0.2
    cam.data.clip_end = 5_000_000
    bpy.context.scene.camera = cam


def main() -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 40
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 92
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.0

    clear_extras()
    add_plume()
    add_ground()
    add_cloud_sea()

    stills = []
    only = os.environ.get("IV_ONLY", "")
    for time_key, preset in TIMES.items():
        if only and only not in ("all", time_key) and not only.startswith(time_key):
            continue
        scene.view_settings.exposure = preset["exp"]
        make_world(time_key, preset["elev"], preset["rot"], preset["strength"])
        add_sun(preset)
        if time_key == "night":
            add_starfield()
        for view, pose in POSES.items():
            if only and only not in ("all", f"{time_key}-{view}"):
                continue
            for i in range(3):
                plume = bpy.data.objects.get(f"Plume-{i}")
                if plume:
                    plume.hide_render = view == "micro"
            setup_camera(pose, pose[2])
            scene.render.filepath = str(OUT / f"still-{time_key}-{view}.jpg")
            t0 = time.time()
            bpy.ops.render.render(write_still=True)
            print(f"RENDERED {scene.render.filepath} in {time.time() - t0:.1f}s")
            stills.append(
                {
                    "file": f"still-{time_key}-{view}.jpg",
                    "time": time_key,
                    "view": view,
                    "label": f"{LABELS['zh'][time_key]} · {LABELS['zh'][view]} / {LABELS['en'][time_key]} · {LABELS['en'][view]}",
                }
            )
        # Remove the per-time light and stars before the next pass.
        for name in ("Sun", "StarField"):
            obj = bpy.data.objects.get(name)
            if obj:
                bpy.data.objects.remove(obj, do_unlink=True)

    if not only:
        manifest = {
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "stills": stills,
            "video": "flyby.mp4" if (OUT / "flyby.mp4").exists() else None,
        }
        (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        print("manifest written")


if __name__ == "__main__":
    main()
