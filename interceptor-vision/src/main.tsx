import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(window.WebGL2RenderingContext && canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}

const root = document.getElementById("root")!;

if (hasWebGL2()) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} else {
  createRoot(root).render(
    <div className="no-webgl">
      <h1>需要 WebGL 2</h1>
      <p>
        当前浏览器或显卡驱动未提供 WebGL 2，无法运行实时视景。请使用最新版 Chrome / Edge，并确认已启用硬件加速。
      </p>
      <p className="no-webgl__en">
        This visualisation needs WebGL 2. Please use a recent Chrome or Edge with hardware acceleration enabled.
      </p>
      <p className="no-webgl__en">静态图与说明仍可在文档中的 screenshots 目录查看。</p>
    </div>,
  );
}
