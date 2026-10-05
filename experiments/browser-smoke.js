'use strict';
// Optional development tool. Install Playwright outside the runtime tree.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
	const browser = await chromium.launch({
		headless: true,
		executablePath: process.env.BROWSER_EXECUTABLE || undefined,
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote']
	});
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		const errors = [], network = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
		await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
		await page.waitForFunction(() => document.getElementById('clock').textContent !== 'T + 000.0 s');
		await page.click('#pause');
		const clock = await page.locator('#clock').textContent();
		await page.waitForTimeout(250);
		assert.equal(await page.locator('#clock').textContent(), clock);
		assert.equal(await page.locator('#step').isEnabled(), true);
		for (let i = 0; i < 15; i++) await page.click('#step');
		assert.notEqual(await page.locator('#clock').textContent(), clock);
		const instrumentCard = page.locator('aside .card').first();
		const magnetCardHeight = (await instrumentCard.boundingBox()).height;
		await page.getByRole('button', { name: 'Reflector R1', exact: true }).click();
		assert.equal(await page.locator('#magnet-controls').isVisible(), false);
		assert.equal((await instrumentCard.boundingBox()).height, magnetCardHeight);
		await page.locator('#angle').fill('45');
		assert.equal(await page.locator('#angle-value').textContent(), '45°');
		await page.getByRole('button', { name: 'Magnet M1', exact: true }).click();
		await page.click('#polarity');
		assert.match(await page.locator('#polarity').textContent(), /Repel/);
		await page.locator('#c').focus();
		await page.keyboard.press('e');
		assert.equal(await page.locator('#angle-value').textContent(), '95°');
		const bounds = await page.locator('#c').boundingBox();
		const scale = Math.min(bounds.width / 800, bounds.height / 650);
		const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2 - 270 * scale;
		await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 90 * scale, y, { steps: 5 }); await page.mouse.up();
		assert.equal(await page.getByRole('button', { name: 'Magnet M1', exact: true }).getAttribute('aria-pressed'), 'true');
		const outsideX = x + 130 * scale, outsideY = y;
		await page.mouse.move(outsideX, outsideY); await page.mouse.down();
		await page.mouse.move(x + 90 * scale, y + 40 * scale, { steps: 8 }); await page.mouse.up();
		assert.equal(await page.locator('#angle-value').textContent(), '-175°');
		await page.locator('#guidance').fill('0');
		assert.equal(await page.locator('#guidance-value').textContent(), '0%');
		await page.click('#reset');
		assert.equal(await page.locator('#clock').textContent(), 'T + 000.0 s');
		assert.equal(await page.locator('#angle-value').textContent(), '90°');
		assert.equal(await page.locator('#guidance-value').textContent(), '65%');
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(100);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await page.screenshot({ path: process.env.SCREENSHOT_PATH || '/tmp/reactor-mobile.png', fullPage: true });
		await page.click('#pause');
		await page.waitForFunction(() => document.getElementById('clock').textContent !== 'T + 000.0 s');
		assert.deepEqual(errors, []);
		assert.deepEqual(network, []);
		console.log('PASS: file://, offline loading, pause/step/reset, selection, angle, polarity, keyboard, drag, guidance, mobile layout, resume, and no page errors');
	} finally {
		await browser.close();
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
