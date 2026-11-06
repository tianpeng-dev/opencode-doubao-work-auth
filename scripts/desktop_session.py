# /// script
# requires-python = ">=3.11"
# dependencies = ["browser-cookie3==0.20.1", "ccl_chromium_reader @ git+https://github.com/cclgroupltd/ccl_chromium_reader.git@ad37443541dd91dac3ac1fb2eecaeb8693f36815"]
# [tool.uv]
# override-dependencies = ["ccl_simplesnappy @ git+https://github.com/cclgroupltd/ccl_simplesnappy.git@3d085230baa8c46cf2090ebba29bf6e8eab31087"]
# ///

import argparse
import json
import os
import plistlib
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

import browser_cookie3
from ccl_chromium_reader.ccl_chromium_localstorage import LocalStoreDb

parser = argparse.ArgumentParser()
parser.add_argument("--profile", default="auto")
parser.add_argument("--temp-dir", required=True)
args = parser.parse_args()

if sys.platform != "darwin":
    raise RuntimeError("桌面账号导入目前支持 macOS；需要安装并登录豆包工作。")

root = Path.home() / "Library/Application Support/DoubaoWork"
local_state = json.loads((root / "Local State").read_text())
profile = args.profile
if profile == "auto":
    profile = local_state["profile"]["last_used"]
if not re.fullmatch(r"Default|Profile \d+", profile):
    raise ValueError("配置名称必须为 auto、Default 或 Profile 加数字。")
cookie_file = root / profile / "Cookies"
if not cookie_file.is_file():
    raise FileNotFoundError(f"豆包工作配置 {profile} 中没有 Cookies 文件。")

temp_root = Path(args.temp_dir)
temp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(temp_root, 0o700)
tempfile.tempdir = str(temp_root)

# Chromium Local Storage 通过第三方库读取一致的文件副本。
with tempfile.TemporaryDirectory(prefix="client-identity-", dir=temp_root) as temporary:
    snapshot = Path(temporary) / "leveldb"
    shutil.copytree(root / profile / "Local Storage/leveldb", snapshot)
    with LocalStoreDb(snapshot) as db:
        records = [r for r in db.iter_all_records(include_deletions=True)
                   if r.storage_key == "chrome://doubaowork-chat" and r.script_key == "__tea_cache_tokens_1044603"]
        if not records:
            raise RuntimeError("当前配置没有豆包工作客户端标识，请打开客户端对话页面后重新导入。")
        latest = max(records, key=lambda r: r.leveldb_seq_number)
        if not latest.is_live:
            raise RuntimeError("豆包工作客户端标识已清除，请打开客户端对话页面后重新导入。")
        client_tokens = json.loads(latest.value)
client_info = {
    "deviceId": str(local_state["aha"]["device"]["device_id"]),
    "webId": str(client_tokens["web_id"]),
    "teaUuid": str(client_tokens["user_unique_id"]),
}
if not all(re.fullmatch(r"[0-9]+", value) and value != "0" for value in client_info.values()):
    raise RuntimeError("豆包工作客户端标识格式无效，请重新打开客户端并确认登录状态。")

# 提前检查钥匙串，避免解密库在凭据缺失时使用默认密码。
key = subprocess.run(
    ["/usr/bin/security", "-q", "find-generic-password", "-w", "-a", "DoubaoWork", "-s", "DoubaoWork Safe Storage"],
    capture_output=True, check=True, timeout=20,
)
if not key.stdout.strip():
    raise RuntimeError("DoubaoWork Safe Storage 没有可用密码。")
del key
jar = browser_cookie3.ChromiumBased(
    browser="DoubaoWork", cookie_file=str(cookie_file), domain_name="doubao.com",
    osx_key_service="DoubaoWork Safe Storage", osx_key_user="DoubaoWork",
).load()
cookies = [
    {"key": c.name, "value": c.value, "domain": c.domain.lstrip("."), "path": c.path,
     "secure": c.secure, "expires": c.expires, "hostOnly": not c.domain_initial_dot}
    for c in jar if c.domain.lstrip(".") == "doubao.com" or c.domain.endswith(".doubao.com")
]
if not any(c["key"] in ("sessionid", "sessionid_ss") and c["value"] for c in cookies):
    raise RuntimeError("该豆包工作配置没有登录会话，请在客户端登录后重新导入。")
# 标准输出仅供父进程读取，父进程不记录凭据。
with (Path("/Applications/DoubaoWork.app/Contents/Info.plist")).open("rb") as app_info:
    client_version = plistlib.load(app_info)["CFBundleShortVersionString"]
with (Path("/Applications/DoubaoWork.app/Contents/Helpers/DoubaoWork Browser.app/Contents/Frameworks/DoubaoWork Browser Framework.framework/Resources/Info.plist")).open("rb") as browser_info:
    client_info["chromiumVersion"] = plistlib.load(browser_info)["CFBundleShortVersionString"]
print(json.dumps({"profile": profile, "cookies": cookies, "clientVersion": client_version, "clientInfo": client_info}))
