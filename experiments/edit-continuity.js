'use strict';
// Continuity probe for field edits: a small magnet/reflector nudge must move the rail and the
// beam by about the size of the nudge, never by a whole different lap. Not loaded by the page.
const { Reactor } = require('../js/reactor.js');

function moveAlongPerimeter(item, ds) {
	const s0 = item.y === -270 ? item.x + 350 : item.x === 350 ? 700 + item.y + 270 : item.y === 270 ? 1240 + 350 - item.x : 1940 + 270 - item.y;
	const s = ((s0 + ds) % 2480 + 2480) % 2480;
	if (s < 700) { item.x = s - 350; item.y = -270; }
	else if (s < 1240) { item.x = 350; item.y = s - 970; }
	else if (s < 1940) { item.x = 1590 - s; item.y = 270; }
	else { item.x = -350; item.y = 2210 - s; }
}

// Beam-path divergence from an unedited run over the HORIZON seconds that follow the edit.
function divergence(editAt, edit, horizon = 15) {
	const base = new Reactor();
	const trail = [];
	for (let i = 0; i < 120 * (editAt + horizon); i++) { base.step(); trail.push(base.particle.x, base.particle.y); }
	const sim = new Reactor();
	const edited = [];
	for (let i = 0; i < 120 * (editAt + horizon); i++) {
		if (i === 120 * editAt) { edit(sim); sim.predict(true); }
		sim.step();
		edited.push(sim.particle.x, sim.particle.y);
	}
	let max = 0, sum = 0, n = 0;
	for (let i = 120 * editAt; i < 120 * (editAt + horizon); i++) {
		const d = Math.hypot(trail[2 * i] - edited[2 * i], trail[2 * i + 1] - edited[2 * i + 1]);
		max = Math.max(max, d); sum += d; n++;
	}
	return { mean: sum / n, max, riding: sim.liveDebug.engaged, offset: sim.liveDebug.distance };
}

console.log('== beam divergence after a 2 px magnet nudge (must stay on its orbit) ==');
for (const t of [3, 8, 12, 20, 40]) {
	const r = divergence(t, sim => moveAlongPerimeter(sim.magnets[0], 2));
	console.log(`  t=${String(t).padStart(2)} s  mean ${r.mean.toFixed(1).padStart(5)} px  max ${r.max.toFixed(1).padStart(5)} px  riding ${r.riding}  offset ${r.offset.toFixed(1)} px`);
}

console.log('== beam divergence after a 0.05 rad reflector nudge ==');
for (const t of [3, 12, 40]) {
	const r = divergence(t, sim => { sim.reflectors[1].angle += 0.05; });
	console.log(`  t=${String(t).padStart(2)} s  mean ${r.mean.toFixed(1).padStart(5)} px  max ${r.max.toFixed(1).padStart(5)} px  riding ${r.riding}  offset ${r.offset.toFixed(1)} px`);
}

console.log('== large edit must still re-derive the rail (the lap really breaks) ==');
for (const ds of [60, 140]) {
	const r = divergence(20, sim => moveAlongPerimeter(sim.magnets[0], ds), 20);
	console.log(`  M1 +${ds} px  mean ${r.mean.toFixed(1)} px  max ${r.max.toFixed(1)} px  riding ${r.riding}  offset ${r.offset.toFixed(1)} px`);
}

// Drag emulation: every pointermove edits the field and steps the sim, as the page does.
function drag(secondsBefore, totalPx, frames, magnet) {
	const sim = new Reactor();
	for (let i = 0; i < 120 * secondsBefore; i++) sim.step();
	sim.predict();
	const item = magnet ? sim.magnets[0] : sim.reflectors[1];
	const jumps = [];
	let engaged = 0, samples = 0;
	for (let f = 0; f < frames; f++) {
		if (magnet) moveAlongPerimeter(item, totalPx / frames);
		else item.angle += totalPx / frames;
		sim.predict(true);
		const offset = sim.liveDebug.distance;
		if (sim.liveDebug.engaged) engaged++;
		samples++;
		jumps.push(offset);
		for (let s = 0; s < 2; s++) sim.step();
	}
	jumps.sort((a, b) => a - b);
	console.log(`  ${magnet ? 'M1 drag' : 'R2 rotate'} ${totalPx} over ${frames} events @t=${secondsBefore}s: rail offset median ${jumps[jumps.length >> 1].toFixed(1)} px, p90 ${jumps[(frames * 0.9) | 0].toFixed(1)} px, engaged ${(100 * engaged / samples).toFixed(0)}%`);
}

console.log('== drag keeps the beam on the rail (offset must stay inside the 40 px tolerance) ==');
for (const t of [3, 12, 40]) drag(t, 60, 60, true);
drag(12, 200, 60, true);
drag(40, 0.6, 60, false);
