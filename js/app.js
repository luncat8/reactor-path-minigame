(function () {
	'use strict';
	const { Reactor, DT, TAU } = ReactorCore;
	const sim = new Reactor();
	const canvas = document.getElementById('c');
	const ctx = canvas.getContext('2d');
	const $ = id => document.getElementById(id);
	const ui = {
		angle: $('angle'), angleValue: $('angle-value'), strength: $('strength'), strengthValue: $('strength-value'),
		polarity: $('polarity'), magnetControls: $('magnet-controls'), guidance: $('guidance'), guidanceValue: $('guidance-value'), pause: $('pause'), step: $('step'),
		clock: $('clock'), status: $('status'), light: $('status-light'), stability: $('stability'), cooling: $('cooling-value')
	};
	let selected = 0, paused = false, accumulator = 0, last = 0, lastUI = 0;
	let scale = 1, width = 800, height = 650, pixelRatio = 1;
	const pointer = { x: 0, y: 0 };
	const drag = { mode: '', target: -1, offsetX: 0, offsetY: 0, lastAngle: 0 };
	const buttons = [], meters = [];
	const forecastLabels = ['', '', ''];
	const instrument = () => selected < 4 ? sim.magnets[selected] : sim.reflectors[selected - 4];
	for (let i = 0; i < 6; i++) {
		const button = document.createElement('button');
		button.textContent = i < 4 ? 'M' + (i + 1) : 'R' + (i - 3);
		button.setAttribute('aria-label', (i < 4 ? 'Magnet ' : 'Reflector ') + button.textContent);
		button.addEventListener('click', () => { selected = i; syncControls(); });
		$('instruments').append(button);
		buttons.push(button);
	}
	for (const target of sim.targets) {
		const row = document.createElement('div');
		row.className = 'target-meter';
		row.innerHTML = '<div class="meter-label"><span>Target ' + target.name + '</span><b>−100%</b></div><div class="meter-track"><div class="meter-fill"></div></div>';
		$('target-meters').append(row);
		meters.push({ label: row.querySelector('b'), fill: row.querySelector('.meter-fill') });
	}

	function syncControls() {
		const item = instrument();
		for (let i = 0; i < buttons.length; i++) buttons[i].setAttribute('aria-pressed', i === selected);
		const magnetSelected = selected < 4;
		$('selected-name').textContent = (magnetSelected ? 'Magnet ' : 'Reflector ') + item.name;
		$('selected-kind').textContent = magnetSelected ? 'PERIMETER FIELD' : 'GRAZING SURFACE';
		ui.magnetControls.classList.toggle('inactive', !magnetSelected);
		ui.magnetControls.inert = !magnetSelected;
		ui.magnetControls.setAttribute('aria-hidden', String(!magnetSelected));
		ui.strength.disabled = !magnetSelected;
		ui.polarity.disabled = !magnetSelected;
		const degrees = Math.round(Math.atan2(Math.sin(item.angle), Math.cos(item.angle)) * 180 / Math.PI);
		ui.angle.value = degrees;
		ui.angleValue.textContent = degrees + '°';
		if (!magnetSelected) return;
		ui.strength.value = item.strength;
		ui.strengthValue.textContent = item.strength.toFixed(2) + '×';
		ui.polarity.textContent = item.polarity > 0 ? '+  Attract · click to reverse' : '−  Repel · click to reverse';
	}

	function changed() {
		// Recompute from the unchanged live state, including while paused.
		sim.predict();
		sim.forecastClock = 0;
		sim.stableTime = 0;
		syncControls();
		updateUI();
	}
	ui.angle.addEventListener('input', () => { instrument().angle = Number(ui.angle.value) * Math.PI / 180; changed(); });
	ui.strength.addEventListener('input', () => { instrument().strength = Number(ui.strength.value); changed(); });
	ui.polarity.addEventListener('click', () => { instrument().polarity *= -1; changed(); });
	ui.guidance.addEventListener('input', () => { sim.guideStrength = Number(ui.guidance.value); changed(); });
	function togglePause() {
		paused = !paused;
		accumulator = 0;
		ui.pause.textContent = paused ? 'Resume' : 'Pause';
		ui.step.disabled = !paused;
		updateUI();
	}
	ui.pause.addEventListener('click', togglePause);
	ui.step.addEventListener('click', () => { if (paused) { sim.step(); updateUI(); } });
	$('reset').addEventListener('click', () => {
		sim.reset(); selected = 0; accumulator = 0;
		ui.guidance.value = sim.guideStrength;
		syncControls(); updateUI();
	});

	function locate(event) {
		const bounds = canvas.getBoundingClientRect();
		pointer.x = (event.clientX - bounds.left - width / 2) / scale;
		pointer.y = (event.clientY - bounds.top - height / 2) / scale;
	}
	function perimeter(item, x, y) {
		x = Math.max(-350, Math.min(350, x));
		y = Math.max(-270, Math.min(270, y));
		if (350 - Math.abs(x) < 270 - Math.abs(y)) x = x < 0 ? -350 : 350;
		else y = y < 0 ? -270 : 270;
		item.x = x; item.y = y;
	}
	function instrumentAt(index) { return index < 4 ? sim.magnets[index] : sim.reflectors[index - 4]; }
	function containsItem(item, index, x, y) {
		const dx = x - item.x, dy = y - item.y;
		if (index >= 4 && Math.abs(dx) <= 20 && Math.abs(dy + 19) <= 8) return true;
		const cosine = Math.cos(item.angle), sine = Math.sin(item.angle);
		const localX = dx * cosine + dy * sine;
		const localY = -dx * sine + dy * cosine;
		if (index < 4) return localX >= -24 && localX <= 40 && Math.abs(localY) <= 20;
		return Math.abs(localX) <= item.length / 2 + 5 && Math.abs(localY) <= 10;
	}
	function hitInstrument(x, y) {
		if (containsItem(instrument(), selected, x, y)) return selected;
		for (let i = 0; i < 6; i++) {
			if (i === selected) continue;
			if (containsItem(instrumentAt(i), i, x, y)) return i;
		}
		return -1;
	}
	canvas.addEventListener('pointerdown', event => {
		if (event.button !== 0) return;
		locate(event);
		const hit = hitInstrument(pointer.x, pointer.y);
		if (hit >= 0) selected = hit;
		canvas.focus(); syncControls();
		const item = instrument();
		if (hit === selected && selected < 4) {
			drag.mode = 'move';
			drag.target = selected;
			drag.offsetX = item.x - pointer.x;
			drag.offsetY = item.y - pointer.y;
		} else if (hit < 0) {
			drag.mode = 'rotate';
			drag.target = selected;
			drag.lastAngle = Math.atan2(pointer.y - item.y, pointer.x - item.x);
		} else return;
		canvas.setPointerCapture(event.pointerId);
	});
	canvas.addEventListener('pointermove', event => {
		if (!drag.mode) return;
		locate(event);
		const item = instrumentAt(drag.target);
		if (drag.mode === 'move') {
			perimeter(item, pointer.x + drag.offsetX, pointer.y + drag.offsetY);
			changed();
			return;
		}
		const dx = pointer.x - item.x, dy = pointer.y - item.y;
		if (dx * dx + dy * dy < 1) return;
		const angle = Math.atan2(dy, dx);
		let delta = angle - drag.lastAngle;
		if (delta > Math.PI) delta -= TAU;
		else if (delta < -Math.PI) delta += TAU;
		item.angle += delta;
		drag.lastAngle = angle;
		changed();
	});
	function stopDrag() { drag.mode = ''; drag.target = -1; }
	canvas.addEventListener('pointerup', stopDrag);
	canvas.addEventListener('pointercancel', stopDrag);
	canvas.addEventListener('lostpointercapture', stopDrag);
	canvas.addEventListener('wheel', event => {
		event.preventDefault(); instrument().angle += Math.sign(event.deltaY) * Math.PI / 36; changed();
	}, { passive: false });
	canvas.addEventListener('keydown', event => {
		const key = event.key.toLowerCase(), item = instrument();
		if (key === ' ') { event.preventDefault(); togglePause(); return; }
		if (key === 'q' || key === 'e') { event.preventDefault(); item.angle += (key === 'q' ? -1 : 1) * Math.PI / 36; changed(); return; }
		if (selected >= 4 || !key.startsWith('arrow')) return;
		event.preventDefault();
		// Move along the perimeter, including around corners.
		let s = item.y === -270 ? item.x + 350 : item.x === 350 ? 700 + item.y + 270 : item.y === 270 ? 1240 + 350 - item.x : 1940 + 270 - item.y;
		s = (s + ((key === 'arrowright' || key === 'arrowdown') ? 12 : -12) + 2480) % 2480;
		if (s < 700) { item.x = s - 350; item.y = -270; }
		else if (s < 1240) { item.x = 350; item.y = s - 970; }
		else if (s < 1940) { item.x = 1590 - s; item.y = 270; }
		else { item.x = -350; item.y = 2210 - s; }
		changed();
	});

	function resize() {
		const bounds = canvas.getBoundingClientRect();
		width = bounds.width; height = bounds.height;
		pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.round(width * pixelRatio); canvas.height = Math.round(height * pixelRatio);
		scale = Math.min(width / 800, height / 650);
	}
	new ResizeObserver(resize).observe(canvas);

	function circle(x, y, radius) { ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); }
	function line(ax, ay, bx, by) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
	function draw() {
		ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.translate(width / 2, height / 2); ctx.scale(scale, scale);
		ctx.lineWidth = 1;
		ctx.strokeStyle = '#1c2a2e';
		for (let x = -320; x <= 320; x += 40) for (let y = -240; y <= 240; y += 40) {
			ctx.fillStyle = '#2a3a3e'; ctx.fillRect(x, y, 1.5, 1.5);
		}
		ctx.strokeRect(-350, -270, 700, 540);
		ctx.strokeStyle = '#304246';
		line(-14, 0, 14, 0); line(0, -14, 0, 14);
		ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = '#567177';
		ctx.fillText('CONFINEMENT FIELD', -348, -297); ctx.textAlign = 'right'; ctx.fillText('700 × 540', 350, -297);
		for (let i = 0; i < sim.zones.length; i++) {
			const z = sim.zones[i];
			circle(z.x, z.y, z.radius); ctx.fillStyle = '#342720'; ctx.fill(); ctx.strokeStyle = '#815940'; ctx.stroke();
			ctx.save(); ctx.clip(); ctx.strokeStyle = '#50392c';
			for (let d = -100; d < 100; d += 10) line(z.x + d, z.y - 60, z.x + d + 120, z.y + 60);
			ctx.restore(); ctx.fillStyle = '#c18e68'; ctx.textAlign = 'center'; ctx.font = '9px monospace'; ctx.fillText('COOL', z.x, z.y + 3);
		}
		ctx.strokeStyle = '#70e2d34f'; ctx.lineWidth = 1.3; ctx.beginPath();
		for (let i = 0; i < sim.path.count; i++) {
			if (i === 0) ctx.moveTo(sim.path.x[i], sim.path.y[i]);
			else ctx.lineTo(sim.path.x[i], sim.path.y[i]);
		}
		ctx.stroke();
		ctx.strokeStyle = '#bdeee0a6'; ctx.lineWidth = 1.7; ctx.beginPath();
		for (let i = 0; i < sim.trailCount; i++) {
			const j = (sim.trailHead - sim.trailCount + i + sim.trailX.length) % sim.trailX.length;
			if (i === 0) ctx.moveTo(sim.trailX[j], sim.trailY[j]);
			else ctx.lineTo(sim.trailX[j], sim.trailY[j]);
		}
		ctx.stroke();
		for (let i = 0; i < sim.targets.length; i++) {
			const t = sim.targets[i];
			ctx.lineWidth = 1; circle(t.x, t.y, t.radius); ctx.fillStyle = '#70e2d30a'; ctx.fill(); ctx.strokeStyle = '#70e2d37a'; ctx.stroke();
			circle(t.x, t.y, 4); ctx.fillStyle = '#70e2d3'; ctx.fill();
			ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.fillText(t.name, t.x, t.y - 15);
			ctx.fillStyle = '#263a3d'; ctx.fillRect(t.x - 32, t.y + t.radius + 9, 64, 4);
			ctx.fillStyle = '#70e2d3'; ctx.fillRect(t.x - 32, t.y + t.radius + 9, Math.min(64, 32 * t.predicted / t.desired), 4);
			ctx.fillStyle = '#b2c9c5'; ctx.fillRect(t.x, t.y + t.radius + 7, 1, 8);
			ctx.font = '10px monospace'; ctx.fillText(forecastLabels[i], t.x, t.y + t.radius + 28);
		}
		for (let i = 0; i < sim.reflectors.length; i++) {
			const r = sim.reflectors[i]; ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(r.angle);
			ctx.strokeStyle = selected === i + 4 ? '#eee2b5' : '#819ba9'; ctx.lineWidth = selected === i + 4 ? 5 : 3;
			line(-r.length / 2, 0, r.length / 2, 0); ctx.restore();
			circle(r.x, r.y, 5); ctx.fillStyle = '#d7ddce'; ctx.fill();
			ctx.textAlign = 'center'; ctx.fillStyle = '#9aaeb5'; ctx.fillText(r.name, r.x, r.y - 19);
		}
		for (let i = 0; i < sim.magnets.length; i++) {
			const m = sim.magnets[i];
			ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(m.angle);
			ctx.fillStyle = m.polarity > 0 ? '#163d37' : '#342c27'; ctx.strokeStyle = m.polarity > 0 ? '#70e2d3' : '#dfb88a'; ctx.lineWidth = selected === i ? 2 : 1;
			ctx.beginPath(); ctx.roundRect(-17, -15, 34, 30, 5); ctx.fill(); ctx.stroke();
			if (selected === i) { ctx.strokeStyle = '#dcefe780'; ctx.strokeRect(-22, -20, 44, 40); }
			ctx.strokeStyle = '#b8cec8'; ctx.lineWidth = 1.5; line(19, 0, 36, 0); line(30, -4, 36, 0); line(30, 4, 36, 0);
			ctx.restore(); ctx.fillStyle = '#d5e5de'; ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.fillText(m.name, m.x, m.y + 4);
		}
		circle(sim.particle.x, sim.particle.y, 11); ctx.fillStyle = '#afffe419'; ctx.fill();
		circle(sim.particle.x, sim.particle.y, 5); ctx.fillStyle = '#afffe44d'; ctx.fill();
		circle(sim.particle.x, sim.particle.y, 2.7); ctx.fillStyle = '#f0fff6'; ctx.fill();
	}

	function signed(value) { return (value >= 0 ? '+' : '−') + Math.abs(value).toFixed(0) + '%'; }
	function updateUI() {
		ui.clock.textContent = 'T + ' + sim.time.toFixed(1).padStart(5, '0') + ' s';
		ui.guidanceValue.textContent = Math.round(sim.guideStrength * 100) + '%';
		for (let i = 0; i < sim.targets.length; i++) {
			const t = sim.targets[i];
			meters[i].label.textContent = signed((t.actual / t.desired - 1) * 100);
			meters[i].fill.style.width = Math.min(100, 50 * t.actual / t.desired) + '%';
			forecastLabels[i] = signed((t.predicted / t.desired - 1) * 100);
		}
		ui.cooling.textContent = (sim.cooling * 100).toFixed(1) + '%';
		ui.cooling.title = 'Forecast: ' + (sim.predictedCooling * 100).toFixed(1) + '%';
		ui.status.textContent = paused ? 'SIMULATION PAUSED' : sim.stableTime >= 8 ? 'REACTOR STABLE' : sim.stableTime > 0 ? 'BALANCE ACQUIRED' : 'TUNING REACTOR';
		ui.light.style.background = sim.stableTime > 0 ? '#70e2d3' : '#edbb70';
		ui.stability.textContent = sim.stableTime > 0 ? Math.min(8, sim.stableTime).toFixed(1) + ' / 8.0 s stable' : 'Hold balance for 8 seconds';
	}
	function frame(now) {
		const elapsed = last ? Math.min((now - last) / 1000, 0.1) : 0;
		last = now;
		if (!paused) accumulator += elapsed;
		while (accumulator >= DT) { sim.step(); accumulator -= DT; }
		if (now - lastUI > 100) { updateUI(); lastUI = now; }
		draw(); requestAnimationFrame(frame);
	}
	document.addEventListener('visibilitychange', () => { last = 0; accumulator = 0; });
	syncControls(); updateUI(); resize(); requestAnimationFrame(frame);
})();
