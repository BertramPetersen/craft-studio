import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, arch } from 'node:os';
import * as opentype from 'opentype.js';

function syntheticFont(): Buffer {
  const glyphs = Array.from({ length: 95 }, (_, i) => {
    const path = new opentype.Path();
    if (i > 0) { path.moveTo(40, 0); path.lineTo(400, 0); path.lineTo(220, 650); path.close(); }
    return new opentype.Glyph({ name: `test-${i + 32}`, unicode: i + 32, advanceWidth: 500, path });
  });
  const notdef = new opentype.Glyph({ name: '.notdef', advanceWidth: 500, path: new opentype.Path() });
  return Buffer.from(new opentype.Font({ familyName: 'Synthetic Test Font', styleName: 'Regular',
    unitsPerEm: 1000, ascender: 800, descender: -200, glyphs: [notdef, ...glyphs] }).toArrayBuffer());
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#canvas')).toBeVisible();
});

test('edit a shape, drag once, undo, and export physical-size paths', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await expect(page.locator('#object-width')).toHaveValue('40.00');
  const originalX = Number(await page.locator('#object-x').inputValue());
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const before = await page.evaluate(() => (window as any).__craftDebug.stats().historyCommits);
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 20 });
  expect(await page.evaluate(() => (window as any).__craftDebug.stats().historyCommits)).toBe(before);
  await page.mouse.up();
  await expect(page.locator('#object-x')).toHaveValue((originalX + 20).toFixed(2));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#object-x')).toHaveValue(originalX.toFixed(2));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export SVG', exact: true }).click();
  const svg = await readFile((await (await download).path())!, 'utf8');
  expect(svg).toContain('width="40mm"'); expect(svg).toContain('height="30mm"');
  expect(svg).toContain('<path'); expect(svg).not.toContain('<text');
  expect(errors).toEqual([]);
});

test('project download/reopen, SVG import, and unsafe SVG refusal', async ({ page }) => {
  await page.locator('#svg-file').setInputFiles({ name: 'owned-vector.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="30mm" viewBox="0 0 50 30"><path d="M0 0H50V30H0Z" fill="#315ec7"/></svg>') });
  await expect(page.locator('#layer-count')).toHaveText('1');
  await expect(page.locator('#object-width')).toHaveValue('50.00');
  const downloaded = page.waitForEvent('download'); await page.locator('#save-project').click();
  const project = await readFile((await (await downloaded).path())!, 'utf8');
  page.once('dialog', dialog => dialog.accept()); await page.locator('#new-project').click();
  await expect(page.locator('#layer-count')).toHaveText('0');
  await page.locator('#project-file').setInputFiles({ name: 'reopened.craft.json', mimeType: 'application/json', buffer: Buffer.from(project) });
  await expect(page.locator('#layer-count')).toHaveText('1');
  await page.locator('#svg-file').setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.pwned=1</script><path d="M0 0H10V10Z"/></svg>') });
  await expect(page.locator('#notice')).toBeVisible();
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  await expect(page.locator('#layer-count')).toHaveText('1');
});

test('font worker outlines, persistence after reload, and empty-text refusal', async ({ page }) => {
  await page.locator('#font-file').setInputFiles({ name: 'synthetic-test.otf', mimeType: 'font/otf', buffer: syntheticFont() });
  await expect(page.locator('#font-count')).toHaveText('1');
  await page.locator('.font-row').first().click();
  await expect(page.locator('.font-row').first()).toBeFocused();
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await expect(page.locator('#object-text')).toHaveValue('Your words');
  await page.locator('#object-text').fill('ABC'); await page.locator('#apply-text').click();
  await expect(page.locator('#object-name')).toHaveValue('ABC');
  await page.locator('#object-text').fill('   '); await page.locator('#apply-text').click();
  await expect(page.locator('#notice')).toContainText('cuttable');
  await expect(page.locator('#object-name')).toHaveValue('ABC');
  await expect(page.locator('#status')).toContainText('Draft saved', { timeout: 5000 });
  await page.reload();
  await expect(page.locator('#font-count')).toHaveText('1'); await expect(page.locator('#layer-count')).toHaveText('1');
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await expect(page.locator('#layer-count')).toHaveText('2');
  const downloaded = page.waitForEvent('download'); await page.locator('#export-svg').click();
  const svg = await readFile((await (await downloaded).path())!, 'utf8');
  expect(svg).toContain('<path'); expect(svg).not.toContain('<text');
});

test('project replacement confirmation preserves the current design when declined', async ({ page }) => {
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await page.locator('#project-name').fill('Keep this design');
  const incoming = { name: 'replacement.craft.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'craft-studio', version: 1, name: 'Replacement', nodes: [] })) };
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#project-file').setInputFiles(incoming);
  await expect(page.locator('#layer-count')).toHaveText('1');
  await expect(page.locator('#project-name')).toHaveValue('Keep this design');
  await expect(page.locator('#undo')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#project-file').setInputFiles(incoming);
  await expect(page.locator('#layer-count')).toHaveText('0');
  await expect(page.locator('#project-name')).toHaveValue('Replacement');
});

test('layer focus survives updates and tab arrows do not nudge artwork', async ({ page }) => {
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await page.locator('.layer-select').first().click();
  await expect(page.locator('.layer-select').first()).toBeFocused();
  const x = Number(await page.locator('#object-x').inputValue());
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#object-x')).toHaveValue((x + 1).toFixed(2));
  await expect(page.locator('.layer-select').first()).toBeFocused();
  await page.locator('#layers-tab').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#fonts-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#fonts-tab')).toBeFocused();
  await expect(page.locator('#object-x')).toHaveValue((x + 1).toFixed(2));
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#layers-tab')).toBeFocused();
  await page.getByRole('button', { name: 'Lock Rectangle', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unlock Rectangle', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#object-x')).toHaveValue((x + 1).toFixed(2));
});

test('virtualized layers and a synthetic 5000-object gesture', async ({ page }, info) => {
  await page.evaluate(() => (window as any).__craftDebug.fixture(5000));
  await expect(page.locator('#layer-count')).toHaveText('5000');
  expect(await page.locator('.layer-row').count()).toBeLessThan(40);
  await page.locator('#layers-scroll').evaluate(el => { el.scrollTop = 0; });
  await page.locator('.layer-select').first().click();
  // Zoom to an ordinary editing scale, rather than rendering the entire fixture as tiny tiles.
  await page.evaluate(() => (window as any).__craftDebug.editingView());
  const point = await page.evaluate(() => (window as any).__craftDebug.dragPoint());
  const before = await page.evaluate(() => (window as any).__craftDebug.stats());
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 45, point.y + 25, { steps: 60 });
  const during = await page.evaluate(() => (window as any).__craftDebug.stats());
  expect(during.historyCommits).toBe(before.historyCommits);
  await page.mouse.up();
  const after = await page.evaluate(() => (window as any).__craftDebug.stats());
  expect(after.historyCommits).toBe(before.historyCommits + 1);
  expect(after.staticBuilds).toBe(before.staticBuilds + 1);
  const sorted = [...after.renderTimes].sort((a, b) => a - b);
  const evidence = { fixture: '5000 simple filled rectangles', host: process.platform, renderer: 'headless Chromium',
    cpu: cpus()[0]?.model, architecture: arch(), browserVersion: page.context().browser()?.version(),
    visibleObjects: after.visible, sampledCanvasDrawP95Ms: sorted[Math.floor(sorted.length * 0.95)], frames: sorted.length,
    historyCommitsDuringDrag: during.historyCommits - before.historyCommits,
    caveats: ['Canvas draw duration only, not pointer-to-present latency.', 'Synthetic local fixture; no Design Space comparison or Windows run.'] };
  await info.attach('synthetic-gesture-metrics', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  await writeFile(info.outputPath('synthetic-gesture-metrics.json'), JSON.stringify(evidence, null, 2) + '\n');
});
