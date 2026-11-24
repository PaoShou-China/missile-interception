// Rebuild public/renders/manifest.json from whatever stills/video exist.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "public", "renders");

const LABELS = {
  zh: { day: "白天", dusk: "黄昏", night: "夜晚", macro: "宏观", meso: "中观", micro: "微观" },
  en: { day: "Day", dusk: "Dusk", night: "Night", macro: "Macro", meso: "Meso", micro: "Micro" },
};

const stills = [];
for (const time of ["day", "dusk", "night"]) {
  for (const view of ["macro", "meso", "micro"]) {
    const file = `still-${time}-${view}.jpg`;
    if (!fs.existsSync(path.join(dir, file))) continue;
    stills.push({
      file,
      time,
      view,
      label: `${LABELS.zh[time]} · ${LABELS.zh[view]} / ${LABELS.en[time]} · ${LABELS.en[view]}`,
    });
  }
}

const video = fs.existsSync(path.join(dir, "flyby.mp4")) ? "flyby.mp4" : null;
const manifest = {
  generatedAt: new Date().toISOString(),
  stills,
  video,
};
fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest: ${stills.length} stills, video=${video ?? "none"}`);
