import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const png = await readFile(new URL("ui/icon.png", root));
const icon = `data:image/png;base64,${png.toString("base64")}`;
if (Buffer.byteLength(icon) > 1024 * 1024) throw new Error("App 图标超过 Magpie 的 1 MB 限制。");
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
pkg.magpie.icon = icon;
await writeFile(new URL("package.json", root), JSON.stringify(pkg, null, 2) + "\n");
await writeFile(new URL("lib/icon.mjs", root), `// 由 scripts/icon.mjs 从豆包工作 App 原始图标生成。\nexport const icon = ${JSON.stringify(icon)};\n`);
console.log(`App 图标已写入插件元数据（${png.length} 字节）。`);
