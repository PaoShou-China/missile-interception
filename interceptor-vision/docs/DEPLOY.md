# 部署说明

## 方式一：GitHub Pages（当前使用）

本 Demo 作为航空航天视景仓库的独立子应用，部署在：

```
https://paoshou-china.github.io/missile-interception/interceptor-vision/
```

主站的“进入三维探索 / 打开三维探索器”入口现在会跳转到该地址（`?from=site`，页内提供“返回学术主页”）；原数据驱动探索器保留在 `#/explore-legacy`，供历史链接与回归测试使用。

`.github/workflows/aerospace-vision-pages.yml` 在原有构建流程中追加了三步：

1. `npm ci`（working-directory: `interceptor-vision`）
2. `npm run build`
3. 将 `interceptor-vision/dist/` 复制到主站构建目录 `dist/interceptor-vision/`，并校验 `index.html`、`assets/interceptor-lod0.glb`、`renders/manifest.json` 存在。

触发条件：推送到 `main` 且改动包含 `interceptor-vision/**` 或该工作流文件；也可手动 `workflow_dispatch`。

Vite 使用 `base: "./"`，因此构建产物在任意子路径下都能正确加载资源。

### 验证

```bash
curl -I https://paoshou-china.github.io/missile-interception/interceptor-vision/
curl -I https://paoshou-china.github.io/missile-interception/interceptor-vision/assets/interceptor-lod0.glb
curl -s https://paoshou-china.github.io/missile-interception/interceptor-vision/renders/manifest.json
```

预期：均返回 `200`；manifest 中包含 9 张静帧与 `flyby.mp4`。另外打开主站首页点击“进入三维探索”，应落到本 Demo 且页面显示“返回学术主页”。

## 方式二：任意静态服务器

```bash
cd interceptor-vision
npm ci
npm run build
# 将 dist/ 整个目录上传到任意静态服务器
```

无需后端；所有资源位于 `assets/` 与 `renders/`。

## 本地预览

```bash
npm run preview -- --port 4176 --strictPort
```

## 缓存

资源文件名哈希仅作用于 JS/CSS；GLB/HDRI/截图使用固定文件名。更新资产后若浏览器仍显示旧图，强制刷新（Ctrl+F5）即可。

## CI 说明

- 该工作流会先运行原仓库既有测试，再构建本 Demo；本 Demo 不参与原仓库的 Playwright 合约测试。
- Blender 资产与离线成品已提交到仓库，CI 不安装 Blender（构建时间可控）。
- 若后续需要在 CI 重建 Blender 资产，可在工作流中安装 Blender 4.2 并执行 `blender/README.md` 中的命令。
