import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { config } from "./config.js";

const GB = 1e9;

/** Memory the OS can hand out without swapping: free + reclaimable cache. */
export function availableMemory(): number {
  if (process.platform === "darwin") {
    // macOS's own estimate counts reclaimable file cache (e.g. a just-unloaded model's file),
    // which page counts from vm_stat miss.
    try {
      const pct = Number(execFileSync("memory_pressure", { encoding: "utf8" }).match(/free percentage:\s*(\d+)%/)?.[1]);
      if (Number.isFinite(pct)) return (pct / 100) * os.totalmem();
    } catch {
      // fall back to vm_stat
    }
    const out = execFileSync("vm_stat", { encoding: "utf8" });
    const page = Number(out.match(/page size of (\d+)/)?.[1] ?? 16384);
    const pages = (label: string) => Number(out.match(new RegExp(`Pages ${label}:\\s+(\\d+)`))?.[1] ?? 0);
    return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page;
  }
  if (process.platform === "linux") {
    const kb = Number(fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0);
    return kb * 1024;
  }
  return os.freemem();
}

async function ollamaJson<T>(pathname: string): Promise<T> {
  const res = await fetch(`${config.ollamaUrl}${pathname}`);
  if (!res.ok) throw new Error(`ollama ${pathname}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Refuse to load a model that won't fit: on Apple Silicon an oversized model pushes the whole
 * machine into swap and it freezes. Weights + ~5% runtime overhead + KV cache (~1 GB per 16k context;
 * qwen3.6:35b-a3b measured 22 GB resident at 16k) + headroom for the headless browser used during collection.
 */
export async function assertModelFits(model: string) {
  if (process.env.SKIP_MEMORY_CHECK === "1") return;
  const { models: loaded } = await ollamaJson<{ models: { name: string }[] }>("/api/ps");
  if (loaded.some((m) => m.name === model || m.name === `${model}:latest`)) return; // already resident

  const { models } = await ollamaJson<{ models: { name: string; size: number }[] }>("/api/tags");
  const size = models.find((m) => m.name === model || m.name === `${model}:latest`)?.size;
  if (!size) return;

  const needed = size * 1.05 + (config.numCtx / 16384) * 1 * GB + 1.5 * GB;
  const available = availableMemory();
  if (available >= needed) return;

  const fmt = (b: number) => `${(b / GB).toFixed(1)} GB`;
  throw new Error(
    `Not enough free memory for ${model}: needs ~${fmt(needed)}, ${fmt(available)} available.
Loading it anyway would push the system into heavy swapping and freeze it.
  • Quit memory-heavy apps (Docker Desktop, extra browser windows, other editor windows), then retry
  • or use a smaller model via LLM_MODEL (e.g. one under ~15 GB)
  • or override at your own risk: SKIP_MEMORY_CHECK=1`,
  );
}
