'use strict';
// Headless wiring check for the page: a minimal DOM stub loads index.html's scripts and
// drives the transport controls. No browser binary in this workspace, so this stands in for
// the Playwright smoke test. Not loaded by the page.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Reactor, DT, FORECAST_PERIOD } = require('../js/reactor.js');
const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

function makeElement(id) {
	const element = {
		id, textContent: '', value: '', checked: false, disabled: false, inert: false,
		innerHTML: '', title: '', style: {}, children: [], handlers: {},
		classList: {
			names: new Set(),
			toggle(name, on) { if (on === undefined) on = !this.names.has(name); on ? this.names.add(name) : this.names.delete(name); },
			add(name) { this.names.add(name); }, remove(name) { this.names.delete(name); },
			contains(name) { return this.names.has(name); }
		},
		attributes: {},
		setAttribute(name, value) { this.attributes[name] = String(value); },
		getAttribute(name) { return this.attributes[name]; },
		addEventListener(type, handler) { (this.handlers[type] = this.handlers[type] || []).push(handler); },
		appendChild(child) { this.children.push(child); return child; },
		append(...kids) { for (const kid of kids) this.children.push(kid); },
		querySelector(selector) { return this.children.find(child => child.matches && child.matches(selector)) || makeElement('stub'); },
		querySelectorAll() { return []; },
		getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 650 }; },
		focus() {}, setPointerCapture() {}, releasePointerCapture() {},
		dispatch(type, event) { for (const handler of this.handlers[type] || []) handler(event || { preventDefault() {} }); }
	};
	return element;
}

const elements = new Map();
const byId = id => {
	if (!elements.has(id)) elements.set(id, makeElement(id));
	return elements.get(id);
};
const canvas = byId('c');
canvas.getContext = () => new Proxy({}, {
	get: (target, name) => (name in target ? target[name] : () => {}),
	set: (target, name, value) => { target[name] = value; return true; }
});
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
for (const id of ids) byId(id);

let frames = [];
globalThis.document = {
	getElementById: byId,
	createElement: () => makeElement('created'),
	addEventListener: () => {}
};
globalThis.window = { devicePixelRatio: 1 };
globalThis.ResizeObserver = class { observe() {} };
globalThis.requestAnimationFrame = callback => { frames.push(callback); };

require('../js/app.js');
assert.equal(frames.length, 1, 'the page starts one animation frame');

let now = 0;
function advance(seconds, step = 1000 / 60) {
	for (let t = step; t <= seconds * 1000; t += step) { now += step; frames[0](now); }
}
function clock() { return Number(byId('clock').textContent.replace(/[^0-9.]/g, '')); }

// The transport speed slider scales the simulation and the forecast refresh together.
byId('speed').value = '10';
byId('speed').dispatch('input');
assert.equal(byId('speed-value').textContent, '10×');
advance(1);
const fast = clock();
assert.ok(fast > 6 && fast < 14, `1 s of real time advanced ${fast.toFixed(1)} s of simulation at 10x`);

byId('speed').value = '1';
byId('speed').dispatch('input');
assert.equal(byId('speed-value').textContent, '1×');
const before = clock();
advance(1);
const slow = clock() - before;
assert.ok(slow > 0.4 && slow < 1.6, `1 s of real time advanced ${slow.toFixed(2)} s of simulation at 1x`);
assert.equal(new Reactor().forecastInterval, FORECAST_PERIOD, 'the default refresh interval is the documented period');

// Pause freezes the clock, Step advances one fixed step, Reset restores every default.
byId('pause').dispatch('click');
const paused = clock();
advance(1);
assert.equal(clock(), paused, 'pausing stops the simulation');
for (let i = 0; i < 15; i++) byId('step').dispatch('click');
assert.ok(clock() > paused, 'stepping advances the simulation');
byId('pause').dispatch('click');

byId('speed').value = '25';
byId('speed').dispatch('input');
byId('reset').dispatch('click');
assert.equal(byId('speed-value').textContent, '30×', 'reset restores the default speed');
assert.equal(byId('guidance-value').textContent, '90%', 'reset restores the guidance strength');

// A field edit while riding transports the held rail instead of re-fitting it.
byId('debug-guidance').checked = true;
byId('debug-guidance').dispatch('change');
advance(12);
const railBefore = { period: Number(byId('guide-readout').textContent.match(/loop ([\d.]+) s/)[1]) };
byId('instruments').children[0].dispatch('click');
const angle = byId('angle');
angle.value = String(Number(angle.value) + 2);
angle.dispatch('input');
const readout = byId('guide-readout').textContent;
const railAfter = Number(readout.match(/loop ([\d.]+) s/)[1]);
assert.ok(Math.abs(railAfter - railBefore.period) < 0.25, `a 2° edit keeps the lap (${railBefore.period} → ${railAfter} s)`);
assert.ok(readout.includes('riding'), 'the beam still rides the transported rail');

// Reflectors drag freely inside the chamber (not clamped to the frame like magnets), and
// dragging must not also rotate them.
byId('instruments').children[4].dispatch('click'); // select R1
const reflectorAngleBefore = byId('angle').value;
advance(5);
const readoutBefore = byId('guide-readout').textContent;
canvas.dispatch('pointerdown', { clientX: 170, clientY: 245, button: 0, pointerId: 1 });
canvas.dispatch('pointermove', { clientX: 400, clientY: -50, button: 0, pointerId: 1 });
canvas.dispatch('pointerup', {});
assert.equal(byId('angle').value, reflectorAngleBefore, 'dragging the reflector body moves it, not rotates it');
advance(5);
const readoutAfter = byId('guide-readout').textContent;
assert.notEqual(readoutAfter, readoutBefore, 'dragging a reflector reshapes the field the beam rides');
byId('reset').dispatch('click');

// The auto-fuel row wires the checkbox and the number input; the last add press sets the number.
byId('auto-fuel-count').value = '2';
byId('auto-fuel-count').dispatch('input');
byId('auto-fuel').checked = true;
byId('auto-fuel').dispatch('change');
byId('add-fuel').dispatch('click');
assert.equal(byId('auto-fuel-count').value, '4', 'the last add press sets the auto number');
byId('reset').dispatch('click');
assert.equal(byId('auto-fuel').checked, false, 'reset turns auto off');
assert.equal(byId('auto-fuel-count').value, '3', 'reset restores the default number');

console.log('ui wiring: speed slider, pause/step, reset, edit continuity, and auto fuel all behave');
