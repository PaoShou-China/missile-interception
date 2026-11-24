"""Quick Workbench turntable used for model QA (not a deliverable render)."""

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

OUT = Path(sys.argv[sys.argv.index("--") + 1]) if "--" in sys.argv else Path("C:/temp/missile_preview")
OUT.mkdir(parents=True, exist_ok=True)

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_cavity = True
scene.render.resolution_x = 1200
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.world = scene.world or bpy.data.worlds.new("W")
scene.world.color = (0.05, 0.06, 0.08)

views = {
    "three-quarter": ((6.2, -7.4, 3.2), (0, 0, 0)),
    "front": ((11.0, -0.6, 0.9), (0, 0, 0)),
    "side": ((0.2, -11.0, 0.6), (0, 0, 0)),
    "rear": ((-7.4, -6.2, 2.6), (0, 0, 0)),
    "top": ((0.4, -0.6, 11.0), (0, 0, 0)),
    "nose": ((4.6, -1.9, 0.7), (2.6, 0, 0)),
    "tail": ((-4.9, -2.2, 1.0), (-2.2, 0, 0)),
}

cam = scene.camera
cam.data.type = "ORTHO"
cam.data.ortho_scale = 8.6

for name, (loc, target) in views.items():
    cam.location = loc
    look = Vector(target) - Vector(loc)
    cam.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()
    if name in ("nose",):
        cam.data.ortho_scale = 3.2
    elif name in ("tail",):
        cam.data.ortho_scale = 4.4
    else:
        cam.data.ortho_scale = 8.6
    scene.render.filepath = str(OUT / f"{name}.png")
    bpy.ops.render.render(write_still=True)
    print("preview", scene.render.filepath)
