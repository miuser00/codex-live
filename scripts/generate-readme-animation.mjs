import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(repoRoot, "codex-live-web", "node_modules", "playwright"));

const chromeCandidates = [
  path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
];
const executablePath = chromeCandidates.find((candidate) => candidate && existsSync(candidate));
if (!executablePath) throw new Error("Google Chrome is required to render the README animation.");

const assetsDir = path.join(repoRoot, "assets");
const gifPath = path.join(assetsDir, "codex-live-flow.gif");
const posterPath = path.join(assetsDir, "codex-live-flow-poster.png");
const frameDir = await mkdtemp(path.join(tmpdir(), "codex-live-flow-"));

await mkdir(assetsDir, { recursive: true });

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(scriptDir, "readme-animation.html")).href);
  await page.waitForFunction(() => window.animationReady === true);

  const fps = 10;
  const frameCount = 60;
  for (let frame = 0; frame < frameCount; frame += 1) {
    await page.evaluate((time) => window.setAnimationTime(time), frame * (1000 / fps));
    const framePath = path.join(frameDir, `frame-${String(frame).padStart(3, "0")}.png`);
    await page.screenshot({ path: framePath });
  }

  await page.evaluate(() => window.setAnimationTime(3600));
  await page.screenshot({ path: posterPath });
} finally {
  await browser.close();
}

try {
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-framerate", "10",
    "-i", path.join(frameDir, "frame-%03d.png"),
    "-vf", "split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
    "-loop", "0",
    gifPath,
  ], { stdio: "inherit" });
} finally {
  const safeTempRoot = path.resolve(tmpdir());
  const safeFrameDir = path.resolve(frameDir);
  if (safeFrameDir.startsWith(safeTempRoot) && path.basename(safeFrameDir).startsWith("codex-live-flow-")) {
    await rm(safeFrameDir, { recursive: true, force: true });
  }
}

console.log(`Generated ${path.relative(repoRoot, gifPath)}`);
console.log(`Generated ${path.relative(repoRoot, posterPath)}`);
