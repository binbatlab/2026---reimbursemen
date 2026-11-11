// 读写本地配置（工号、是否记住密码），放在 skill 根目录
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG = resolve(ROOT, ".ywtb.config.json");

export function readConfig() {
  try {
    if (!existsSync(CONFIG)) return {};
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(patch) {
  const cur = readConfig();
  const next = { ...cur, ...patch, savedAt: new Date().toISOString().slice(0, 19) };
  writeFileSync(CONFIG, JSON.stringify(next, null, 1), "utf8");
  return next;
}

export function configPath() { return CONFIG; }
