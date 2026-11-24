# Blender 资产管线

本目录的所有资产均由 Blender Python 脚本生成，可完整复现。Blender 版本：**4.2.12 LTS**（官方便携版即可，无需插件）。

## 1. 生成拦截弹

外形参考公开的 **SM-3 Block IB/IIA** 三视图：尖锥头罩、细长弹体 + 中部收线整流罩/边条、四片尾部控制舵面、直径略大的 MK72 式助推级与喷管（不含前置鸭翼）。

```bash
blender -b -P blender/scripts/build_missile.py
```

脚本内容：

- 旋成体弹体（150 站位 cosine 采样 + 72 边环），尖锥头罩、圆柱段与助推级。
- 收线整流罩/边条两片（后掠、带厚度与倒角）、四片尾部控制舵、无前置鸭翼。
- 光电头罩（深色介电材质 + 发光镜片）、MK72 式助推级、尾部喷管与发光喉部、面板环、服务环带、作动器、天线、舱口、腹部整流罩。
- 程序化面板线法线贴图与粗糙度贴图（1024×512），通过圆柱 UV 贴在弹体上。
- 三种 LOD：LOD0 全精度、LOD1 简化 45%、LOD2 简化 16%。
- 导出 `public/assets/interceptor-lod{0,1,2}.glb` 与 `blender/interceptor.blend`；glTF 纹理以 WebP（质量 90）嵌入，首屏 GLB 约 0.72 MB。

坐标：Blender +X 弹头、+Z 向上；glTF 导出后为 +X 弹头、+Y 向上，与网页相机一致。

## 2. 生成环境资产

```bash
blender -b -P blender/scripts/build_environment.py
```

- `terrain-day.jpg` / `terrain-normal.jpg`：2048×2048 可平铺地形（海洋、海岸、平原、山地）。
- `terrain-day.webp`：地形颜色的 WebP 副本，供网页实时渲染使用。
- `cloud-a.png` / `cloud-b.png`：1024×1024 分形云层（RGB + Alpha）。
- `cloud-a.webp` / `cloud-b.webp`：云层 WebP 副本，供网页实时渲染使用。
- `env-day.hdr` / `env-dusk.hdr` / `env-night.hdr`：512×256 equirectangular HDRI（每张约 0.52 MB）。
  - Cycles 渲染 Nishita 天空（白天 42°、黄昏 3°、夜晚关闭太阳），32-bit EXR 转 Radiance RGBE。
  - Three.js 使用 `RGBELoader` 作为 `scene.environment`，提供 PBR 反射与环境光。

## 3. 离线静帧

```bash
blender -b blender/interceptor.blend -P blender/scripts/render_stills.py
# 只渲染一张用于调试：
IV_ONLY=day-macro blender -b blender/interceptor.blend -P blender/scripts/render_stills.py
```

- Cycles CPU，40 samples + 降噪，1600×900，AgX 色彩管理。
- 9 张：昼/昏/夜 × 宏观/中观/微观。
- 场景包含：Nishita 天空、太阳光、两层云海、地表平面（用于填补云隙）、喷焰自发光锥、夜间星空。
- 输出 `public/renders/still-<time>-<view>.jpg` 与 `manifest.json`。

## 4. 离线飞行动画

```bash
blender -b blender/interceptor.blend -P blender/scripts/render_flyby.py
# 快速测试（6 帧）：
IV_FRAMES=6 blender -b blender/interceptor.blend -P blender/scripts/render_flyby.py
```

- EEVEE Next，48 TAA samples，1600×900，24 fps，240 帧（10 s）。
- 相机沿螺旋轨迹从 15.5 m 拉近至约 7 m，再拉开；合成器加入 Fog Glow 辉光。
- 直接输出 H.264：`public/renders/flyby.mp4`（Blender 内置 FFmpeg，无需外部 ffmpeg）。

## 5. 资产清单与复现注意

| 文件 | 说明 |
| --- | --- |
| `interceptor.blend` | 弹体原始工程，含预览相机 |
| `environment.blend` | 环境资产生成工程（天空、云、地形） |
| `public/assets/interceptor-lod*.glb` | 实时渲染资产，材质为 Principled PBR，纹理以 WebP 嵌入 |
| `public/assets/env-*.hdr` | 512×256 RGBE 环境贴图（每张约 0.52 MB） |
| `public/assets/*.webp` | 地形与云层的网页用压缩纹理 |
| `public/renders/*` | 离线成品 |

所有脚本幂等：重复运行会覆盖同名产物。渲染脚本不会修改 `.blend` 源文件。
