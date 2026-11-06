import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
let text = "# Third-party notices\n\n## 豆包工作 App 图标\n\n`ui/icon.png` 为本机豆包工作 App 的原始图标，用于标识接入的供应商。图标及相关商标权利归其权利人所有，不适用本插件代码的 MIT 许可证。本插件为独立适配项目。\n\n## Python 依赖\n\n由 uv 按脚本锁定文件安装，源码未包含在发行包中：\n\n- [browser-cookie3](https://github.com/borisbabic/browser_cookie3)：Cookie 读取与解密。\n- [ccl_chromium_reader](https://github.com/cclgroupltd/ccl_chromium_reader)：Chromium Local Storage 解析，MIT 许可证。\n- [ccl_simplesnappy](https://github.com/cclgroupltd/ccl_simplesnappy)：Snappy 解压。\n\n# Bundled JavaScript dependency licenses\n\n";
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path) continue;
  const folder = new URL(`${path}/`, root);
  const files = await readdir(folder);
  const license = files.find(name => /^licen[sc]e(?:\.md|\.txt)?$/i.test(name));
  if (!license) throw new Error(`缺少依赖许可证：${path}`);
  text += `## ${path.replace(/^node_modules\//, "")} ${info.version}\n\n`;
  text += await readFile(new URL(license, folder), "utf8");
  text += "\n\n";
}
await writeFile(new URL("THIRD_PARTY_NOTICES.md", root), text);
