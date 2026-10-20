#!/usr/bin/env node
/**
 * Headless browser smoke test.
 *  1. vite build
 *  2. vite preview on :4173
 *  3. Chromium (preinstalled under /opt/pw-browsers) via playwright-core: open the game, click through
 *     the main flows, take screenshots, fail on any console error / page error / missing UI.
 *
 * Usage: npm run smoke   (env SMOKE_SKIP_BUILD=1 to reuse dist/, SMOKE_OUT=dir for screenshots)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SMOKE_OUT || '/tmp/claude-0/smoke';
const PORT = Number(process.env.SMOKE_PORT || 4173);
const URL = `http://127.0.0.1:${PORT}/`;
mkdirSync(OUT, { recursive: true });

const problems = [];
const log = (...a) => console.log('[smoke]', ...a);

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dirs = existsSync(base) ? readdirSync(base) : [];
  const pick = (prefix, rel) =>
    dirs
      .filter((d) => d.startsWith(prefix))
      .sort()
      .reverse()
      .map((d) => path.join(base, d, rel))
      .find((p) => existsSync(p));
  return pick('chromium-', 'chrome-linux/chrome') || pick('chromium_headless_shell-', 'chrome-linux/headless_shell');
}

async function waitForServer(url, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview server did not start at ${url}`);
}

async function main() {
  if (!process.env.SMOKE_SKIP_BUILD) {
    log('building…');
    const b = spawnSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit' });
    if (b.status !== 0) throw new Error('vite build failed');
  }

  log('starting preview server…');
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  const killServer = () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  };

  let browser;
  try {
    await waitForServer(URL);
    const executablePath = findChromium();
    if (!executablePath) throw new Error('No Chromium found under /opt/pw-browsers');
    log('chromium:', executablePath);
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      // index.html declares no <link rel="icon">, so Chromium probes /favicon.ico (404). Cosmetic — warn only.
      if (/\/favicon\.ico$/.test(msg.location()?.url ?? '')) return log('warn: /favicon.ico 404 (no icon declared)');
      problems.push(`console.error: ${msg.text()} @ ${msg.location()?.url ?? '?'}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('response', (res) => {
      if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
    });
    page.on('requestfailed', (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));

    let shot = 0;
    const snap = async (name) => {
      const file = path.join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`);
      await page.screenshot({ path: file });
      log('screenshot', file);
    };
    const step = async (name, fn) => {
      try {
        await fn();
        log('ok  ', name);
      } catch (err) {
        problems.push(`step "${name}" failed: ${err.message.split('\n')[0]}`);
        log('FAIL', name, err.message.split('\n')[0]);
      }
    };

    await page.goto(URL, { waitUntil: 'load' });
    await step('canvas renders', async () => {
      await page.waitForSelector('canvas', { timeout: 10_000 });
      await page.waitForTimeout(800);
    });
    await snap('initial');

    await step('open Orders tab', async () => {
      await page.getByRole('tab', { name: /^Orders/ }).click({ timeout: 5000 });
    });
    await step('accept first offer', async () => {
      const before = await page.evaluate(() => document.body.innerText);
      await page.getByRole('button', { name: /^Accept$/ }).first().click({ timeout: 5000 });
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => document.body.innerText);
      if (before === after) throw new Error('UI did not change after Accept');
      if (!/Accepted orders \(1\)/i.test(after)) throw new Error('Accepted orders count did not become 1');
    });
    await snap('order-accepted');

    for (const tab of ['Vehicles', 'Suppliers', 'Staff', 'Finances', 'Upgrades', 'Orders']) {
      await step(`tab ${tab}`, async () => {
        const t = page.getByRole('tab', { name: new RegExp(`^${tab}`) });
        await t.click({ timeout: 5000 });
        const sel = await t.getAttribute('aria-selected');
        if (sel !== 'true') throw new Error(`${tab} tab not selected`);
        await page.waitForTimeout(250);
      });
      await snap(`tab-${tab.toLowerCase()}`);
    }

    await step('click a station on the canvas', async () => {
      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      if (!box) throw new Error('canvas has no bounding box');
      // Sweep a grid over the canvas until a station panel opens.
      for (let fy = 0.15; fy <= 0.85; fy += 0.07) {
        for (let fx = 0.05; fx <= 0.95; fx += 0.05) {
          await canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
          if ((await page.locator('.station-panel').count()) > 0) return;
        }
      }
      throw new Error('no click on the canvas opened a station panel');
    });
    await snap('station-panel');
    await step('close station panel with Escape', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    });

    const timeText = () => page.locator('.tb-stat').filter({ hasText: 'Time' }).locator('.tb-value').innerText();
    await step('pause stops the clock', async () => {
      await page.getByRole('button', { name: /Pause/ }).click({ timeout: 5000 });
      await page.getByText('PAUSED', { exact: true }).waitFor({ timeout: 2000 });
      const t1 = await timeText();
      await page.waitForTimeout(1500);
      const t2 = await timeText();
      if (t1 !== t2) throw new Error(`clock moved while paused: ${t1} → ${t2}`);
    });
    await snap('paused');
    await step('resume + 4× speed advances the clock', async () => {
      await page.getByRole('button', { name: /Resume/ }).click({ timeout: 5000 });
      await page.getByRole('button', { name: '4×' }).click({ timeout: 5000 });
      if ((await page.getByRole('button', { name: '4×' }).getAttribute('aria-pressed')) !== 'true')
        throw new Error('4× not pressed');
      const t1 = await timeText();
      await page.waitForTimeout(2500);
      const t2 = await timeText();
      if (t1 === t2) throw new Error(`clock did not move at 4×: ${t1}`);
    });
    await step('2× and 1× speed buttons', async () => {
      await page.getByRole('button', { name: '2×' }).click({ timeout: 5000 });
      await page.getByRole('button', { name: '1×' }).click({ timeout: 5000 });
    });
    await step('manual save', async () => {
      await page.getByRole('button', { name: /^Save$/ }).click({ timeout: 5000 });
      await page.waitForTimeout(300);
      const has = await page.evaluate(() => Object.keys(localStorage).some((k) => k.includes('motorworx')));
      if (!has) throw new Error('nothing written to localStorage');
    });
    await snap('after-run');

    await step('reload restores from autosave without errors', async () => {
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('canvas', { timeout: 10_000 });
      await page.waitForTimeout(800);
    });
    await snap('reloaded');
  } finally {
    if (browser) await browser.close();
    killServer();
  }

  if (problems.length) {
    console.error(`\n[smoke] FAILED with ${problems.length} problem(s):`);
    for (const p of problems) console.error('  -', p);
    process.exit(1);
  }
  log(`PASSED — screenshots in ${OUT}`);
}

main().catch((err) => {
  console.error('[smoke] fatal:', err);
  process.exit(1);
});
