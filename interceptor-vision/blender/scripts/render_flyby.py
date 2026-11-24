"""
EEVEE fly-by animation rendered straight to H.264.

Run:
    blender -b blender/interceptor.blend -P blender/scripts/render_flyby.py
    IV_FRAMES=12 blender -b ...   # quick test

Output: public/renders/flyby.mp4
"""

from __future__ import annotations

import math
import os
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "renders"
OUT.mkdir(parents=True, exist_ok=True)

FRAMES = int(os.environ.get("IV_FRAMES", "240"))
FPS = 24


def clear_helpers() -> None:
    for name in ("AnimCam", "Sun", "CloudSea", "StarField", "Plume-0", "Plume-1", "Plume-2"):
        obj = bpy.data.objects.get(name)
        if obj:
            bpy.data.objects.remove(obj, do_unlink=True)


def setup_world() -> None:
    world = bpy.data.worlds.new("World-Anim")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA"
    sky.sun_elevation = math.radians(29.0)
    sky.sun_rotation = math.radians(135.0)
    sky.sun_intensity = 0.8
    sky.air_density = 1.1
    sky.dust_density = 1.7
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.08
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    bpy.context.scene.world = world


def add_sun() -> None:
    data = bpy.data.lights.new("Sun", "SUN")
    data.energy = 2.0
    data.color = (1.0, 0.9, 0.8)
    data.angle = math.radians(0.7)
    obj = bpy.data.objects.new("Sun", data)
    bpy.context.collection.objects.link(obj)
    obj.rotation_euler = (math.radians(58), 0, math.radians(135))
    obj.location = (0, 0, 3000)


def add_clouds() -> None:
    for i, (z, tex, scale) in enumerate(((-12000.0, "cloud-a.png", 26.0), (-20000.0, "cloud-b.png", 18.0))):
        bpy.ops.mesh.primitive_plane_add(size=2_400_000, location=(0, 0, z))
        plane = bpy.context.active_object
        plane.name = f"CloudSea-{i}" if i else "CloudSea"
        mat = bpy.data.materials.new(f"MAT_AnimCloud{i}")
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        img = bpy.data.images.load(str(ROOT / "public" / "assets" / tex))
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = (scale, scale, 1)
        coords = nt.nodes.new("ShaderNodeTexCoord")
        nt.links.new(coords.outputs["Generated"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs["Vector"], node.inputs["Vector"])
        shade = nt.nodes.new("ShaderNodeMixRGB")
        shade.blend_type = "MULTIPLY"
        shade.inputs["Fac"].default_value = 0.45
        shade.inputs["Color2"].default_value = (0.85, 0.88, 0.92, 1)
        nt.links.new(node.outputs["Color"], shade.inputs["Color1"])
        nt.links.new(shade.outputs["Color"], bsdf.inputs["Base Color"])
        nt.links.new(node.outputs["Alpha"], bsdf.inputs["Alpha"])
        bsdf.inputs["Roughness"].default_value = 1.0
        mat.blend_method = "BLEND"
        plane.data.materials.append(mat)
        plane.visible_shadow = False


def add_plume() -> None:
    layers = [
        (0.7, 0.055, (1.0, 0.95, 0.85), 16.0),
        (1.15, 0.085, (1.0, 0.55, 0.22), 6.0),
        (1.6, 0.115, (0.35, 0.7, 1.0), 2.0),
    ]
    for i, (length, radius, color, power) in enumerate(layers):
        bpy.ops.mesh.primitive_cone_add(
            vertices=32, radius1=radius, radius2=0.0, depth=length,
            location=(-3.34 - length / 2, 0, 0), rotation=(0, -math.pi / 2, 0),
        )
        cone = bpy.context.active_object
        cone.name = f"Plume-{i}"
        mat = bpy.data.materials.new(f"MAT_AnimPlume{i}")
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


def animate_camera() -> None:
    data = bpy.data.cameras.new("AnimCam")
    data.lens = 42
    data.clip_start = 0.2
    data.clip_end = 5_000_000
    cam = bpy.data.objects.new("AnimCam", data)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    for frame in range(1, FRAMES + 1):
        t = (frame - 1) / max(1, FRAMES - 1)
        angle = -0.5 + t * 2.4 * math.pi
        radius = 15.5 - 8.5 * math.sin(min(1.0, t * 1.25) * math.pi) + 3.5 * t
        height = 2.6 + 3.2 * math.sin(t * math.pi) + 0.6 * math.sin(t * 9.0)
        cam.location = (
            math.cos(angle) * radius,
            math.sin(angle) * radius,
            height,
        )
        look = Vector((-1.2 + 0.6 * math.sin(t * 4.0), 0.0, 0.0))
        direction = look - cam.location
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        cam.keyframe_insert(data_path="location", frame=frame)
        cam.keyframe_insert(data_path="rotation_euler", frame=frame)


def setup_compositor() -> None:
    scene = bpy.context.scene
    scene.use_nodes = True
    nt = scene.node_tree
    nt.nodes.clear()
    rl = nt.nodes.new("CompositorNodeRLayers")
    glare = nt.nodes.new("CompositorNodeGlare")
    glare.glare_type = "FOG_GLOW"
    glare.quality = "HIGH"
    glare.threshold = 1.1
    glare.size = 7
    comp = nt.nodes.new("CompositorNodeComposite")
    nt.links.new(rl.outputs["Image"], glare.inputs["Image"])
    nt.links.new(glare.outputs["Image"], comp.inputs["Image"])


def main() -> None:
    scene = bpy.context.scene
    clear_helpers()
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = 48
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.fps = FPS
    scene.frame_start = 1
    scene.frame_end = FRAMES
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.5
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "HIGH"
    scene.render.ffmpeg.ffmpeg_preset = "GOOD"
    scene.render.filepath = str(OUT / "flyby.mp4")

    setup_world()
    add_sun()
    add_clouds()
    add_plume()
    animate_camera()
    setup_compositor()
    bpy.ops.render.render(animation=True)
    print("animation written", scene.render.filepath)


if __name__ == "__main__":
    main()
