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
| Balanced | 51.7 FPS | DPR ≤1.5，2048 阴影，三层云，SMAA + 暗角 |
| Cinematic | 39.1 FPS | DPR ≤2，4096 阴影，SMAA + 暗角 + 弱 Bloom |

首帧就绪（从导航到 `window.__iv.store.ready`）：**2.999 s**。

关键资源（gzip 前）：

| 资源 | 大小 | 加载耗时 |
| --- | --- | --- |
| `interceptor-lod0.glb` | 1.31 MB | 26 ms |
| `interceptor-lod1.glb` | 0.95 MB | 23 ms |
| `interceptor-lod2.glb` | 0.74 MB | 36 ms |
| `env-day.hdr` | 2.10 MB（首段传输 0.72 MB） | 93 ms |
| `terrain-day.jpg` | 0.21 MB | 6 ms |
| `cloud-a.png` / `cloud-b.png` | 0.63 / 0.49 MB | 11 ms |

控制台错误：**0**。

完整原始数据见 [`performance.json`](performance.json)。

## 复现

```bash
npm run build
npm run preview -- --port 4176 --strictPort
npm run visual:check -- http://127.0.0.1:4176/
```

脚本会重新生成 `docs/screenshots/` 与 `docs/performance.json`。

## 说明

- 上述帧率为集成显卡在无头浏览器中的实测值；独立显卡通常更高。Performance 档已跑满 60 FPS 的浏览器刷新率上限。
- 首帧时间包含并行加载三档 LOD 与 HDRI；实际按相机距离仅渲染其中一档 LOD。
- 若网络较慢，GLB/HDRI 为静态文件，可由任意 CDN 或 Pages 缓存加速。
- 纹理已限制在 1024 级别并嵌入 GLB；进一步压缩可对 GLB 运行 `gltf-transform optimize --texture-compress webp`（Three.js 的 GLTFLoader 支持 `EXT_texture_webp`）。

## 优化手段

- **LOD**：三档 GLB，距离 26 m / 160 m 切换。
- **阴影**：按画质 1024/2048/4096，Performance 关闭。
- **云层**：Performance 仅一层，其余三层，全部使用 alpha 贴图与加法透明度。
- **后期**：仅 Balanced/Cinematic 启用 SMAA + 暗角；Cinematic 额外弱 Bloom（阈值 0.92，强度 0.22），避免泛光滥用。
- **纹理**：程序化面板法线/粗糙度贴图 1024×512，地形 2048²，云层 1024²。
- **几何**：弹体 150 站位 × 72 边环，LOD1/2 分别简化至 45% / 16%。
