# Interceptor Vision · 拦截弹视景

独立的拦截弹三维视景 Demo：Blender 负责模型、纹理与 HDRI，Three.js 负责实时渲染与交互，GitHub Pages 负责静态部署。它与参考工程 `missile_interception` 的制导、控制、弹道算法完全解耦，仅复用其"专业航空航天软件"的界面与渲染思想。

**该应用现在是原平台“进入三维探索”的正式视景页**：首页/导航中的探索入口会重定向到这里；原数据驱动探索器的任务面板、遥测、时间线、图表与相机功能已融合进本页，旧版完整界面保留在 `#/explore-legacy`，仅用于历史链接与回归测试。

在线演示：<https://paoshou-china.github.io/missile-interception/interceptor-vision/>

![白天 · 中观](docs/screenshots/day-meso.png)

## 功能

- **双场景**：`实景`（Blender 拦截弹巡航视景）与 `地球弹道`（WGS84 地球、真实轨迹、发射点/目标基准、拦截点），顶栏一键切换；地球弹道场景支持拖拽旋转、滚轮缩放、双击复位，以及地球/追逐/目标/特写四种相机。
- **三分钟电影**：按原平台节奏把 669 s 任务映射到 180 s，六个分镜（点火/助推/控制面/中段/制导/末段）带字幕、进度拖拽、15 s 快进后退与全屏。
- **双渲染模式**：Three.js 实时交互 + Blender Cycles/EEVEE 离线静帧与飞行动画（网页内画廊展示）。
- **任务与遥测回放**：载入原平台的 1504 帧验证遥测，左侧任务事件（发射/最高点/锁定/交接/拦截，可点击跳转），右侧实时高度、速度、马赫、动压、过载、斜距、质量与舵偏；底部飞行时间轴支持播放/暂停、拖动与 1×/5×/20×/60× 倍速。
- **遥测图表**：8 组曲线（高度、速度、马赫、动压、过载、斜距、四路舵偏、三轴角速率），点击图表可跳转时间，Esc 关闭。
- **多尺度视角**：宏观（地球曲率/云海）、中观（整弹）、微观（尾舵/喷管/边条）、尾追、俯视、电影（预设相机动画）、自由（轨道控制）。
- **真实环境**：HDRI 环境光照、分层云海、地表曲率与大气霞光、太阳/月亮/星空、昼/昏/夜三套预设。
- **三档画质**：Performance / Balanced / Cinematic，控制 DPR、阴影、云层数量与后期（SMAA、暗角、轻微 Bloom）。
- **专业界面**：左侧场景与任务、右侧遥测与环境参数、底部数据时间线；面板折叠、高清截图、全屏、中英文切换、图表与离线影像。
- **资产流水线**：全部模型/纹理/HDRI 由 Blender Python 脚本自动生成，可重复构建；GLB 提供三级 LOD。弹体外形参考公开的 SM-3 Block IB/IIA 三视图（尖锥头罩、收线边条、四片尾舵、MK72 式助推级）。

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
| Space | 播放/暂停 |
| S | 高清截图（PNG） |
| F | 全屏 |
| H | 折叠/展开两侧面板 |
| Esc | 关闭图表 / 离线影像画廊 |

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
│   ├── data/scenario.json             # 原平台的 1504 帧验证遥测
│   └── renders/                       # 离线成品 + manifest.json
├── src/
│   ├── scene/                         # 场景、环境、模型、相机、遥测时钟
│   ├── orbital/                       # 地球弹道场景（WGS84 地球、轨迹、原相机与三分钟电影）
│   ├── data/                          # 遥测加载、插值、时间轴辅助
│   ├── components/                    # 顶栏、面板、任务、遥测、图表、时间线、画廊
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
| 首屏关键资源 | LOD0 0.84 MB，HDRI 0.51 MB，地形/云 WebP 约 0.37 MB |
| 延迟加载 | LOD1 0.43 MB、LOD2 0.21 MB 在首帧后预热 |
| 遥测数据 | `scenario.json` 1.0 MB（gzip 后约 0.2 MB），首帧后 0.9 s 后台加载，不阻塞画面 |
| 地球弹道纹理 | 仅切换到弹道场景时加载：2048 地球 + 1024 云约 0.7 MB（高画质用 8K/4K 约 6.8 MB） |
| 帧率（Intel UHD） | Performance 60.0 / Balanced 54.5 / Cinematic 41.7 FPS |
| 控制台错误 | 0 |

详见 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)。

## 截图

昼 / 昏 / 夜 × 宏 / 中 / 微共 9 张运行截图位于 `docs/screenshots/`，另有 `orbital-earth.png`、`orbital-manual.png`、`orbital-cinematic.png`；Blender 离线静帧位于 `public/renders/`。

## 部署

静态站点，`base` 为相对路径，可部署在任意子路径。当前通过 `.github/workflows/aerospace-vision-pages.yml` 构建并复制到 `dist/interceptor-vision/`。详见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 许可与资产来源

拦截弹模型、地形/云纹理、HDRI 与离线渲染均由本工程脚本原创生成，不包含第三方模型或贴图。参考工程仅用于界面、渲染架构与部署方式的借鉴。
