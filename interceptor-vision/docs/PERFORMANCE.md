# 性能与加载实测

## 测试环境

- 浏览器：Microsoft Edge（Playwright 驱动，headless），1920×1080 视口
- GPU：Intel UHD Graphics（ANGLE / D3D11，集显）
- 服务：`vite preview`（本地生产构建，无 CDN）
- 时间：2026-11-24，构建版本 `1.0.0`

## 结果

| 画质档 | 中景帧率 | 说明 |
| --- | --- | --- |
| Performance | 60.0 FPS | DPR 1.0，关闭阴影，单层云，无后期 |
| Balanced | 54.3 FPS | DPR ≤1.5，2048 阴影，三层云，SMAA + 暗角 |
| Cinematic | 40.2 FPS | DPR ≤2，4096 阴影，SMAA + 暗角 + 弱 Bloom |

首帧就绪（从导航到 `window.__iv.store.ready`）：**0.73 s**（优化前约 3.0 s）。

首屏关键资源（`transferSize`，本地 preview 会 gzip）：

| 资源 | 文件大小 | 传输 | 阻塞首帧 |
| --- | --- | --- | --- |
| `interceptor-lod0.glb` | 0.72 MB | 736 KB | 是 |
| `env-day.hdr`（512×256 RGBE） | 0.51 MB | 245 KB | 是 |
| `terrain-day.webp` | 0.09 MB | 91 KB | 否（Suspense 流式） |
| `cloud-a.webp` / `cloud-b.webp` | 0.14 / 0.12 MB | 147 / 127 KB | 否（Suspense 流式） |
| `interceptor-lod1.glb` | 0.38 MB | 375 KB | 否（首帧后预热） |
| `interceptor-lod2.glb` | 0.18 MB | 175 KB | 否（首帧后预热） |
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
9. **地球弹道按需加载**：地球贴图（2048/1024 约 0.7 MB，高画质 8K/4K 约 6.8 MB）只在切换到“地球弹道”时请求；实景首屏不加载这些纹理，也不创建第二个 WebGL 上下文。

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
- **阴影**：按画质 1024/2048/4096，Performance 关闭。
- **云层**：Performance 仅一层，其余三层，全部使用 alpha 贴图与加法透明度。
- **后期**：仅 Balanced/Cinematic 启用 SMAA + 暗角；Cinematic 额外弱 Bloom（阈值 0.92，强度 0.22），避免泛光滥用。
- **纹理**：程序化面板法线/粗糙度贴图 1024×512（WebP 嵌入 GLB），地形 2048²，云层 1024²（WebP）。
- **几何**：弹体 150 站位 × 72 边环，LOD1/2 分别简化至 45% / 16%。
