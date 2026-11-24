# Interceptor Vision · 拦截弹视景

独立的拦截弹三维视景 Demo：Blender 负责模型、纹理与 HDRI，Three.js 负责实时渲染与交互，GitHub Pages 负责静态部署。它与参考工程 `missile_interception` 的制导、控制、弹道算法完全解耦，仅复用其"专业航空航天软件"的界面与渲染思想。

**该应用现在是原平台“进入三维探索”的正式视景页**：首页/导航中的探索入口会重定向到这里；原数据驱动探索器保留在 `#/explore-legacy`，仅用于历史链接与回归测试。

在线演示：<https://paoshou-china.github.io/missile-interception/interceptor-vision/>

![白天 · 中观](docs/screenshots/day-meso.png)

## 功能

- **双渲染模式**：Three.js 实时交互 + Blender Cycles/EEVEE 离线静帧与飞行动画（网页内画廊展示）。
- **多尺度视角**：宏观（地球曲率/云海）、中观（整弹）、微观（尾舵/喷管/边条）、电影（预设相机动画）、自由（轨道控制）。
- **真实环境**：HDRI 环境光照、分层云海、地表曲率与大气霞光、太阳/月亮/星空、昼/昏/夜三套预设。
- **三档画质**：Performance / Balanced / Cinematic，控制 DPR、阴影、云层数量与后期（SMAA、暗角、轻微 Bloom）。
- **专业界面**：左侧场景、右侧环境与渲染参数、底部时间线；面板折叠、高清截图、全屏、中英文切换。
- **资产流水线**：全部模型/纹理/HDRI 由 Blender Python 脚本自动生成，可重复构建；GLB 提供三级 LOD。

## 快速开始

```bash
cd interceptor-vision
npm ci
npm run dev        # 开发服务器
npm run build      # 生产构建
npm run preview -- --port 4176
```

浏览器打开 `http://127.0.0.1:4176/`。首次加载约 1.1 MB（LOD0 + 当日 HDRI；云层与地形随后流式加载，远端 LOD 在首帧后预热）。

### 快捷键

| 按键 | 功能 |
| --- | --- |
| Space | 播放/暂停电影镜头 |
| S | 高清截图（PNG） |
| F | 全屏 |
| H | 折叠/展开两侧面板 |
| Esc | 关闭离线影像画廊 |

自由视角下：拖拽旋转、滚轮缩放、双击复位。

## Blender 资产管线

Blender 版本：**4.2.12 LTS**（脚本使用 `bpy` 4.2 API）。详细步骤见 [blender/README.md](blender/README.md)。

```bash
# 生成拦截弹 GLB（含三级 LOD 与嵌入纹理）与 .blend
blender -b -P blender/scripts/build_missile.py

# 生成地形、云层纹理与三套 HDRI
blender -b -P blender/scripts/build_environment.py

# 离线静帧（昼/昏/夜 × 宏/中/微）
blender -b blender/interceptor.blend -P blender/scripts/render_stills.py

# 离线飞行动画（EEVEE → H.264）
blender -b blender/interceptor.blend -P blender/scripts/render_flyby.py

# 重新生成离线画廊清单
node scripts/gallery_manifest.mjs
```

产物：

- `blender/interceptor.blend`：可编辑的原始工程。
- `blender/environment.blend`：环境资产生成工程。
- `public/assets/interceptor-lod{0,1,2}.glb`：实时渲染资产，嵌入面板法线/粗糙度纹理。
- `public/assets/env-{day,dusk,night}.hdr`：Radiance RGBE 环境贴图。
- `public/assets/terrain-*.jpg`、`cloud-*.png`：地表与云层纹理。
- `public/renders/`：Cycles 静帧、EEVEE 飞行动画与 `manifest.json`。

## 架构

```
interceptor-vision/
├── blender/
│   ├── scripts/build_missile.py       # 程序化弹体、翼面、尾舵、材质、LOD、GLB 导出
│   ├── scripts/build_environment.py   # 地形/云纹理 + Nishita 天空 HDRI
│   ├── scripts/render_stills.py       # Cycles 离线静帧
│   ├── scripts/render_flyby.py        # EEVEE 飞行动画
│   ├── interceptor.blend              # 原始工程
│   └── environment.blend
├── public/
│   ├── assets/                        # GLB、HDRI、纹理
│   └── renders/                       # 离线成品 + manifest.json
├── src/
│   ├── scene/                         # 场景、环境、模型、相机
│   ├── components/                    # 顶栏、面板、时间线、画廊、加载层
│   ├── state.ts / i18n.ts / styles.css
│   └── App.tsx
└── docs/                              # 截图、性能与部署记录
```

渲染与数据分离：`src/scene/Environment.tsx` 只负责环境与光照，`src/scene/Missile.tsx` 只负责模型与尾焰，UI 状态集中在 `src/state.ts`，Blender 脚本彼此独立。

## 画质档位

| 档位 | DPR | 阴影 | 云层 | 地形细分 | 后期 |
| --- | --- | --- | --- | --- | --- |
| Performance | 1.0 | 关闭 | 1 层 | 72 | 关闭 |
| Balanced | 1–1.5 | 2048 | 3 层 | 120 | SMAA + 暗角 |
| Cinematic | 1–2 | 4096 | 3 层 | 160 | SMAA + 暗角 + 弱 Bloom |

纹理压缩：GLB 纹理由 Blender 以 WebP（质量 90）嵌入；地形/云层使用 WebP 副本；HDRI 降为 512×256。几何使用三级 LOD（约 26 m / 160 m 距离切换），LOD1/LOD2 在首帧后预热，不阻塞首屏。如需进一步压缩可对 GLB 运行 `gltf-transform` 的 Draco/Meshopt 优化。

## 性能（实测）

| 指标 | 结果 |
| --- | --- |
| 首帧就绪 | 0.7 s（本地 preview，1920×1080 无头 Edge） |
| 首屏关键资源 | LOD0 0.72 MB，HDRI 0.51 MB，地形/云 WebP 约 0.37 MB |
| 延迟加载 | LOD1 0.38 MB、LOD2 0.18 MB 在首帧后预热 |
| 帧率（Intel UHD） | Performance 60.0 / Balanced 54.3 / Cinematic 40.2 FPS |
| 控制台错误 | 0 |

详见 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)。

## 截图

昼 / 昏 / 夜 × 宏 / 中 / 微共 9 张运行截图位于 `docs/screenshots/`，Blender 离线静帧位于 `public/renders/`。

## 部署

静态站点，`base` 为相对路径，可部署在任意子路径。当前通过 `.github/workflows/aerospace-vision-pages.yml` 构建并复制到 `dist/interceptor-vision/`。详见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 许可与资产来源

拦截弹模型、地形/云纹理、HDRI 与离线渲染均由本工程脚本原创生成，不包含第三方模型或贴图。参考工程仅用于界面、渲染架构与部署方式的借鉴。
