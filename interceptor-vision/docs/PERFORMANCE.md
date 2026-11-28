# 性能与加载实测

## 测试环境

- 浏览器：Microsoft Edge（Playwright 驱动，headless），1920×1080 视口
- GPU：Intel UHD Graphics（ANGLE / D3D11，集显）
- 服务：`vite preview`（本地生产构建，无 CDN）
- 时间：2026-11-25，构建版本 `1.0.0`
- 技术栈：Vite 8 + React 19 + three 0.187，`base: "./"`

## 结果

| 画质档 | 中景帧率 | 说明 |
| --- | --- | --- |
| Performance | 60.2 FPS | DPR 自适应上限 1.0，关闭阴影，单层云，无后期 |
| Balanced | 60.2 FPS | DPR 自适应上限 1.25，1024 阴影，单层云，原生 MSAA，无后期 |
| Cinematic | 41.4–60.1 FPS | DPR 自适应上限 1.25，2048 阴影，一层淡云，暗角 + Bloom（随负载波动，近期 44–55） |

1080p 下 Cinematic 的 1.5 倍像素比会把集显压到约 38 FPS（Bloom 链 + 全屏填充），而肉眼收益有限，因此上限收到 1.25；需要时自适应分辨率还会继续降到 0.7。

优化前同一台机器：Balanced 54.3 FPS、Cinematic 40.2 FPS。本次优化后中景档两档都跑满或接近 60 FPS。

首帧就绪（从导航到 `window.__iv.store.ready`）：**0.73 s**（优化前约 3.0 s）。

首屏关键资源（`transferSize`，本地 preview 会 gzip）：

| 资源 | 文件大小 | 传输 | 阻塞首帧 |
| --- | --- | --- | --- |
| `interceptor-lod0.glb` | 0.84 MB | 858 KB | 是 |
| `env-day.hdr`（512×256 RGBE） | 0.51 MB | 245 KB | 是 |
| `terrain-day.webp` | 0.09 MB | 91 KB | 否（Suspense 流式） |
| `cloud-a.webp` / `cloud-b.webp` | 0.14 / 0.12 MB | 147 / 127 KB | 否（Suspense 流式） |
| `interceptor-lod1.glb` | 0.43 MB | 425 KB | 否（首帧后预热） |
| `interceptor-lod2.glb` | 0.21 MB | 200 KB | 否（首帧后预热） |
| `data/scenario.json`（已验证遥测） | 1.00 MB | 约 0.2 MB（gzip） | 否（首帧后 0.9 s 后台加载） |

首屏阻塞约 **1.0 MB**（LOD0 + 当日 HDRI）；其余资产在首帧后流式加载。优化前同一条链路约 5.4 MB，且三级 LOD 全部预加载。

控制台错误：**0**。

完整原始数据见 [`performance.json`](performance.json)。

## 本次加载优化

1. **GLB 纹理转 WebP**：Blender glTF 导出 `export_image_format="WEBP"`（质量 90），LOD0 1.31 → 0.72 MB，LOD1 0.95 → 0.38 MB，LOD2 0.74 → 0.18 MB。
2. **HDRI 分辨率减半**：网页用 HDRI 由 1024×512 改为 512×256，单张 2.1 → 0.51 MB；环境光在实时场景中肉眼无差别。
3. **地形/云层 WebP**：`terrain-day.webp` 0.20 → 0.09 MB，两层云 1.1 → 0.26 MB；Blender 离线脚本仍使用原 PNG/JPG。
4. **按需加载 LOD**：首屏只请求 LOD0；LOD1/LOD2 在首帧后 1.2 s 预热，切到宏观视角仍可用，慢网下也不会拖住首屏。
5. **跳过非关键阻塞**：地形与云层包在独立 `<Suspense>` 中，天空、弹体与 HDRI 先出画面。
6. **缓存失效策略**：资产 URL 带 `?v=3` 版本号，重新生成同名资产后强制回源。
7. **慢网提示**：加载超过 8 s 时显示“网络较慢”提示，避免误以为卡死。
8. **遥测延迟加载**：原平台 1504 帧遥测（1.0 MB，gzip 后约 0.2 MB）在首帧后 0.9 s 才请求，任务/遥测面板在数据到位后填充，不拖慢首屏；图表只在打开时渲染 SVG 曲线。
9. **背景卫星影像**：移除原来的地球场景后，实景地面改为按遥测经纬度流式加载 Google 卫星瓦片（8×8 张 z9 ≈ 626 km 覆盖，Canvas 2D 拼接为单张纹理，4 Hz 重新定位；Google 不可用时自动切换 Esri），不再加载 8K 地球贴图，部署包同时减少约 7.5 MB。

## 本次卡顿专项优化

| 项目 | 处理 |
| --- | --- |
| 面板实时模糊 | 移除 `.rail`、时间线、顶栏按钮等处的 `backdrop-filter: blur(10–18px)`，改为 93% 不透明度纯色。模糊层叠在动画画布上由 GPU 每帧重算，是集显卡顿的首要来源。 |
| 像素比 | 固定 `dpr` 1.5/2 改为上限 1.25/1.5，并加入自适应分辨率：连续帧率低于 44 时按 0.15 下调，高于 57 时缓慢回升，最低 0.7。 |
| 绘图缓冲 | 关闭 `preserveDrawingBuffer`（每帧强制拷贝后备缓冲）。截图改为“显式 `gl.render()` 后同一任务内 `toDataURL`”。 |
| 云层 | `meshStandardMaterial` + 双面 + 三层全屏透明面改为无光照 `meshBasicMaterial` + 单面；Balanced 只留一层，Cinematic 两层。 |
| 每帧分配 | `CameraRig`、`Entities`、轨道相机改为复用临时 `Vector3`/`Quaternion`/`Spherical`，消除逐帧 GC 尖峰。 |
| 阴影 | `shadowMap.autoUpdate = false`，约 10 Hz 刷新一次；阴影图上限 4096 → 2048（Balanced 1024）。 |
| 后期 | 仅 Cinematic 启用暗角 + 弱 Bloom；Balanced 依赖画布原生 MSAA，省掉整条 composer 全屏采样。 |
| 场景切换 | 两个 Canvas 常驻，隐藏层 `visibility: hidden` + `frameloop="never"`，不再重新上传 GLB/HDRI/纹理。 |
| 快速播放 | 20× / 60× 连续播放 9–12 s，长任务（>50 ms）0 次，稳定 60 FPS |
| UI 刷新 | 遥测 store 镜像由 12 Hz 降到约 7 Hz；3D 场景直接读连续时钟，不再受 UI 步进影响。 |
| 卫星瓦片上传 | 每张瓦片 landing 后只标脏，由渲染循环统一在 200 ms 窗口内上传一次（原来每张瓦片都整体上传 2048² 纹理并重建 mipmap，是卡顿主因）；关闭 mipmap 生成。 |
| 近景抖动 | 弹体姿态改用连续仿真时钟采样（原来按 12 Hz 的 UI 时间步进），并随相机距离衰减摆动幅度；弹道特写相机对准/姿态做阻尼平滑；修复 60× 播放时 `simClock` 被 7 Hz 镜像回写导致的周期性倒退。 |
| 传感器监控画布（2026-11-28） | `SeekerOverlay.tsx` 将 R-D 雷达热图（`48×28`）与 MWIR 红外焦平面（`128×84`）改为复用离屏 `ImageData` 位图拷贝（替代逐帧 1,344 次 `fillRect`+`rgb()` 字符串），DPR 上限 `1.25`，动态重绘频率与 60 FPS 3D 主循环解耦至 **25 Hz**（暂停拖动瞬时响应），静态 B-Plane/瀑布图面板拆离为独立 `useEffect`。 |
| 播放态零 React 重渲染（2026-11-28） | `Transport.tsx` 移除播放态对高频 `dataTime` 的 React 状态订阅，改用 `useRef` + `requestAnimationFrame` + Zustand `subscribe` 直接更新进度条与时钟文本，消除 60 Hz 组件树重渲染。 |

## 复现

```bash
npm run build
npm run preview -- --port 4176 --strictPort
npm run visual:check -- http://127.0.0.1:4176/
```

脚本会重新生成 `docs/screenshots/` 与 `docs/performance.json`。

## 说明

- 上述帧率为集成显卡在无头浏览器中的实测值；独立显卡通常更高。Performance 档已跑满 60 FPS 的浏览器刷新率上限。
- GitHub Pages 在国内访问可能很慢；首屏已压到约 1 MB，弱网下仍能较快出现画面。若长期访问困难，建议换用国内可访问的静态托管。
- 进一步压缩可对 GLB 运行 `gltf-transform` 的 Draco/Meshopt 优化（需要额外解码器）或降低纹理质量。

## 优化手段

- **LOD**：三档 GLB，距离 26 m / 160 m 切换；首屏仅加载近景 LOD0。
- **阴影**：按画质 1024/1024/2048，约 10 Hz 按需刷新，Performance 关闭。
- **云层**：Performance/Balanced 各一层，Cinematic 两层；无光照单面材质。
- **后期**：仅 Cinematic 启用暗角 + 弱 Bloom（阈值 0.92，强度 0.22）；Balanced 使用画布原生 MSAA。
- **纹理**：程序化面板法线/粗糙度贴图 1024×512（WebP 嵌入 GLB），地形 2048²，云层 1024²（WebP）。
- **几何**：弹体 150 站位 × 72 边环，LOD1/2 分别简化至 45% / 16%。
