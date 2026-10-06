(function (root) {
	'use strict';
	const DT = 1 / 120;
	const FORECAST_DT = 1 / 40;
	const FORECAST_PERIOD = 0.6;
	const SAMPLES = 561;
	const TAU = Math.PI * 2;
	const MAX_GRAZING_SINE = Math.sin(25 * Math.PI / 180);
	const GUIDE_ACCELERATION_PER_PIXEL = 0.5;
	const MAX_GUIDE_ACCELERATION = 50;
	// Below this the steering is numerical dust, not guidance; keep it exactly zero so a beam on its
	// route reports an idle guide instead of drawing a noise-level arrow.
	const MIN_GUIDE_FORCE = 0.01;
	// The live beam and the forecast are guided by a committed plan instead of by the newest
	// prediction. A plan derived from the beam is already its own ballistic continuation, which
	// makes zero force a fixed point: guiding against the newest plan would only ever see the beam
	// sitting exactly on its own extrapolation. Holding a plan for a while restores real error terms
	// whenever the beam or the field changes, and it keeps the route evolving smoothly.
	const PLAN_LAG_DEFAULT = 1.8;
	// The projection search follows the anchor's arc length with a window sized by the beam's own
	// advance per step, so the anchor tracks the route the beam is flying instead of jumping between
	// crossing passes. Lost anchors get one wide look before guidance reports itself idle.
	const GUIDE_BACKTRACK = 8;
	const GUIDE_BACKTRACK_TIME = 0.1;
	const GUIDE_ADVANCE = 24;
	const GUIDE_ADVANCE_TIME = 0.25;
	const GUIDE_RECOVER_TIME = 0.6;
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	const smoothstep = value => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };

	function circleFraction(ax, ay, bx, by, cx, cy, radius) {
		const dx = bx - ax, dy = by - ay;
		const ox = ax - cx, oy = ay - cy;
		const a = dx * dx + dy * dy;
		const c = ox * ox + oy * oy - radius * radius;
		if (a < 1e-12) return c <= 0 ? 1 : 0;
		const b = 2 * (ox * dx + oy * dy);
		const discriminant = b * b - 4 * a * c;
		if (discriminant <= 0) return 0;
		const span = Math.sqrt(discriminant);
		return Math.max(0, Math.min(1, (-b + span) / (2 * a)) - Math.max(0, (-b - span) / (2 * a)));
	}

	function makePath() {
		return {
			x: new Float64Array(SAMPLES), y: new Float64Array(SAMPLES), t: new Float64Array(SAMPLES), s: new Float64Array(SAMPLES),
			forceX: new Float64Array(SAMPLES), forceY: new Float64Array(SAMPLES), count: 0
		};
	}

	// Anchor of a beam on a reference plan: the index of the segment the beam projects onto and the
	// projection itself, its arc length, the local route speed, direction and the cross-track
	// distance. `wide` re-seats the anchor by searching the whole route after a plan change.
	function makeGuide() {
		return { segment: -1, x: 0, y: 0, s: 0, speed: 0, distance: 0, tangentX: 1, tangentY: 0, wide: true };
	}

	function copyGuide(dst, src) {
		dst.segment = src.segment; dst.x = src.x; dst.y = src.y; dst.s = src.s; dst.speed = src.speed;
		dst.distance = src.distance; dst.tangentX = src.tangentX; dst.tangentY = src.tangentY; dst.wide = src.wide;
	}

	function resetGuide(guide) {
		guide.segment = -1; guide.x = 0; guide.y = 0; guide.s = 0; guide.speed = 0;
		guide.distance = 0; guide.tangentX = 1; guide.tangentY = 0; guide.wide = true;
	}

	function pathLength(path) {
		path.s[0] = 0;
		for (let i = 1; i < SAMPLES; i++) path.s[i] = path.s[i - 1] + Math.hypot(path.x[i] - path.x[i - 1], path.y[i] - path.y[i - 1]);
	}

	function reflect(p, ax, ay, dt, reflector) {
		const tx = Math.cos(reflector.angle), ty = Math.sin(reflector.angle);
		const nx = -ty, ny = tx;
		const d0 = (ax - reflector.x) * nx + (ay - reflector.y) * ny;
		const d1 = (p.x - reflector.x) * nx + (p.y - reflector.y) * ny;
		if (d0 * d1 >= 0 || Math.abs(d0 - d1) < 1e-10) return false;
		const u = d0 / (d0 - d1);
		const ix = ax + (p.x - ax) * u, iy = ay + (p.y - ay) * u;
		if (Math.abs((ix - reflector.x) * tx + (iy - reflector.y) * ty) > reflector.length / 2) return false;
		const stepX = p.x - ax, stepY = p.y - ay;
		const stepLength = Math.hypot(stepX, stepY);
		if (stepLength < 1e-10) return false;
		if (Math.abs(stepX * nx + stepY * ny) > stepLength * MAX_GRAZING_SINE) return false;
		const normalSpeed = p.vx * nx + p.vy * ny;
		p.vx -= 2 * normalSpeed * nx;
		p.vy -= 2 * normalSpeed * ny;
		p.x = ix + p.vx * dt * (1 - u);
		p.y = iy + p.vy * dt * (1 - u);
		return true;
	}

	class Reactor {
		constructor() {
			this.scratch = { x: 0, y: 0, vx: 0, vy: 0 };
			this.particle = { x: 0, y: 0, vx: 0, vy: 0 };
			this.guideForce = { x: 0, y: 0 };
			this.guideAim = { x: 0, y: 0, segment: 0 };
			this.liveForce = { x: 0, y: 0 };
			this.liveDebug = {
				nearest: -1, nx: 0, ny: 0, tx: 0, ty: 0,
				distance: 0, angle: 0, magnitude: 0, age: 0
			};
			this.liveGuide = makeGuide();
			this.forecastGuide = makeGuide();
			this.trailX = new Float64Array(900);
			this.trailY = new Float64Array(900);
			this.reset();
		}

		reset() {
			this.time = 0;
			this.guideStrength = 0.65;
			this.guideDistance = 100;
			this.guideDirection = 90;
			this.guideLookahead = 100;
			this.planLag = PLAN_LAG_DEFAULT;
			this.forecastClock = 0;
			this.stableTime = 0;
			this.cooling = 0;
			this.predictedCooling = 0;
			this.trailCount = 0;
			this.trailHead = 0;
			this.magnets = [
				{ x: 0, y: -270, angle: Math.PI / 2, polarity: 1, strength: 1, name: 'M1' },
				{ x: 350, y: 0, angle: Math.PI, polarity: -1, strength: 1, name: 'M2' },
				{ x: 0, y: 270, angle: -Math.PI / 2, polarity: 1, strength: 1, name: 'M3' },
				{ x: -350, y: 0, angle: 0, polarity: -1, strength: 1, name: 'M4' }
			];
			this.reflectors = [
				{ x: -150, y: -100, angle: -0.35, length: 105, name: 'R1' },
				{ x: 160, y: 110, angle: -0.5, length: 105, name: 'R2' }
			];
			this.targets = [
				{ x: -215, y: -80, radius: 38, desired: 0.065, actual: 0, predicted: 0, name: 'A' },
				{ x: 20, y: -175, radius: 38, desired: 0.065, actual: 0, predicted: 0, name: 'B' },
				{ x: 210, y: 65, radius: 38, desired: 0.065, actual: 0, predicted: 0, name: 'C' }
			];
			this.zones = [
				{ x: -85, y: 80, radius: 45 },
				{ x: 105, y: -55, radius: 42 }
			];
			Object.assign(this.particle, { x: -230, y: 0, vx: 0, vy: -151 });
			this.liveForce.x = 0; this.liveForce.y = 0;
			this.liveDebug.nearest = -1;
			resetGuide(this.liveGuide);
			resetGuide(this.forecastGuide);
			this.path = makePath();
			this.sparePath = makePath();
			this.reference = makePath();
			this.referenceTime = 0;
			this.referenceAge = 0;
			this.predict();
		}

		// Project the beam onto the reference route: the true closest point on the polyline, reported
		// as an interpolated position instead of the nearest store sample. The search window is seeded
		// on the anchor's own arc length and sized by the beam's plausible advance, so the anchor
		// follows the route the beam is flying: a crossing pass cannot capture it, and a plan whose
		// timestamps run ahead of the beam (a beam flying faster than the schedule it announced) can
		// no longer be projected behind the beam. Only segments that continue the beam's heading are
		// eligible, so an opposing or perpendicular pass is ignored; guidance reports itself idle
		// rather than guessing a correction. On failure the previous anchor is kept for the retry.
		findGuidePoint(p, route, state, recover) {
			if (route.count < 2) return false;
			const speed = Math.hypot(p.vx, p.vy);
			if (speed < 1e-8) return false;
			const ux = p.vx / speed, uy = p.vy / speed;
			let first = 0, last = route.count - 2;
			if (!state.wide && state.segment >= 0) {
				const back = recover ? speed * GUIDE_RECOVER_TIME : Math.max(GUIDE_BACKTRACK, speed * GUIDE_BACKTRACK_TIME);
				const ahead = recover ? speed * GUIDE_RECOVER_TIME : Math.max(GUIDE_ADVANCE, speed * GUIDE_ADVANCE_TIME);
				first = last = state.segment;
				while (first > 0 && state.s - route.s[first] < back) first--;
				while (last < route.count - 2 && route.s[last + 1] - state.s < ahead) last++;
			}
			let best = -1, bestU = 0, bestDistance2 = Infinity;
			for (let i = first; i <= last; i++) {
				const ax = route.x[i], ay = route.y[i];
				const dx = route.x[i + 1] - ax, dy = route.y[i + 1] - ay;
				const length2 = dx * dx + dy * dy;
				if (length2 < 1e-12) continue;
				if (ux * dx + uy * dy <= 0) continue;
				const u = clamp(((p.x - ax) * dx + (p.y - ay) * dy) / length2, 0, 1);
				const cx = ax + dx * u, cy = ay + dy * u;
				const distance2 = (cx - p.x) * (cx - p.x) + (cy - p.y) * (cy - p.y);
				if (distance2 >= bestDistance2) continue;
				best = i; bestU = u; bestDistance2 = distance2;
			}
			if (best < 0) return false;
			const dx = route.x[best + 1] - route.x[best], dy = route.y[best + 1] - route.y[best];
			const length = Math.hypot(dx, dy);
			const span = route.s[best + 1] - route.s[best];
			const step = route.t[best + 1] - route.t[best];
			state.segment = best;
			state.x = route.x[best] + dx * bestU;
			state.y = route.y[best] + dy * bestU;
			state.s = route.s[best] + span * bestU;
			state.speed = step > 1e-9 ? span / step : 0;
			state.distance = Math.sqrt(bestDistance2);
			state.tangentX = dx / length;
			state.tangentY = dy / length;
			state.wide = false;
			return true;
		}

		// Point at a given arc length ahead of the anchor, interpolated between plan samples.
		aimPoint(route, state, distance, out) {
			const target = state.s + distance;
			let i = state.segment;
			while (i < route.count - 2 && route.s[i + 1] < target) i++;
			const span = route.s[i + 1] - route.s[i];
			const u = span > 1e-9 ? clamp((target - route.s[i]) / span, 0, 1) : 0;
			out.x = route.x[i] + (route.x[i + 1] - route.x[i]) * u;
			out.y = route.y[i] + (route.y[i + 1] - route.y[i]) * u;
			out.segment = i;
			return out;
		}

		// Steering for the live beam, against the committed route. The anchor is the true nearest point
		// of the route; the guide target is one forward-aim interval of route arc beyond it; the force
		// is the component of that correction perpendicular to the beam's velocity. Perpendicular by
		// construction: guidance can steer, but never thrust, brake or point backwards, and a beam
		// sitting on its route needs exactly no correction. Distance and heading only fade the pull.
		guidanceVector(p, route, guidance, debug, state) {
			const force = this.guideForce;
			force.x = 0; force.y = 0;
			// Keep the overlay honest: nothing is reported unless this step really guided.
			if (debug) debug.nearest = -1;
			if (route.count < 2 || guidance <= 0 || this.guideDistance <= 0 || this.guideDirection <= 0) return force;
			const speed = Math.hypot(p.vx, p.vy);
			if (speed < 1e-8) return force;
			if (!this.findGuidePoint(p, route, state, false) && !this.findGuidePoint(p, route, state, true)) return force;
			const ux = p.vx / speed, uy = p.vy / speed;

			const lookaheadDistance = Math.max(2, this.guideLookahead * 0.001 * state.speed);
			const aim = this.aimPoint(route, state, lookaheadDistance, this.guideAim);
			const angleLimit = this.guideDirection * Math.PI / 180;
			// Heading error is the angle between the beam and the route direction at the projection —
			// not the chord to the aim point — so an opposing pass stays gated out.
			const angle = Math.acos(clamp(ux * state.tangentX + uy * state.tangentY, -1, 1));
			const distanceFactor = 1 - smoothstep(state.distance / this.guideDistance);
			const directionFactor = 1 - smoothstep(angle / angleLimit);
			const correctionX = aim.x - p.x, correctionY = aim.y - p.y;
			const along = correctionX * ux + correctionY * uy;
			const steerX = correctionX - along * ux, steerY = correctionY - along * uy;
			const steerLength = Math.hypot(steerX, steerY);
			const magnitude = Math.min(MAX_GUIDE_ACCELERATION, steerLength * GUIDE_ACCELERATION_PER_PIXEL) *
				guidance * distanceFactor * directionFactor;
			const active = steerLength >= 1e-6 && magnitude >= MIN_GUIDE_FORCE;
			if (debug) {
				debug.nearest = state.segment;
				debug.nx = state.x; debug.ny = state.y;
				debug.tx = aim.x; debug.ty = aim.y;
				debug.distance = state.distance; debug.angle = angle;
				debug.magnitude = active ? magnitude : 0;
			}
			if (!active) return force;
			force.x = steerX / steerLength * magnitude;
			force.y = steerY / steerLength * magnitude;
			return force;
		}

		integrate(p, dt, route, guidance, forceOut, debug, state) {
			const ax = p.x, ay = p.y;
			let fx = -0.39 * p.x, fy = -0.64 * p.y;
			for (let i = 0; i < this.magnets.length; i++) {
				const m = this.magnets[i];
				const dx = m.x - p.x, dy = m.y - p.y;
				const distance = Math.hypot(dx, dy) || 1;
				const ux = dx / distance, uy = dy / distance;
				const mx = Math.cos(m.angle), my = Math.sin(m.angle);
				const alignment = -ux * mx - uy * my;
				const force = m.strength * m.polarity * 2800000 / (distance * distance + 18000);
				fx += force * (ux * alignment + mx * 0.25);
				fy += force * (uy * alignment + my * 0.25);
			}
			if (forceOut) { forceOut.x = 0; forceOut.y = 0; }
			if (route.count > 1 && guidance > 0) {
				const force = this.guidanceVector(p, route, guidance, debug, state);
				fx += force.x; fy += force.y;
				if (forceOut) { forceOut.x = force.x; forceOut.y = force.y; }
			}
			// Soft containment; the chamber walls are not reflecting surfaces.
			fx -= Math.sign(p.x) * Math.max(0, Math.abs(p.x) - 285) * 4;
			fy -= Math.sign(p.y) * Math.max(0, Math.abs(p.y) - 210) * 4;
			const speed = Math.hypot(p.vx, p.vy);
			const regulation = (145 - speed) * 0.12 / (speed || 1);
			p.vx += (fx + p.vx * regulation) * dt;
			p.vy += (fy + p.vy * regulation) * dt;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			for (let i = 0; i < this.reflectors.length; i++) {
				if (reflect(p, ax, ay, dt, this.reflectors[i])) break;
			}
		}

		predict() {
			const next = this.sparePath, p = this.scratch, route = this.reference;
			Object.assign(p, this.particle);
			const guide = this.forecastGuide;
			// The forecast starts from the live beam, so it inherits the live anchor when there is
			// one: the prediction then steers against the same stretch of route as the beam.
			resetGuide(guide);
			if (!this.liveGuide.wide && this.liveGuide.segment >= 0) copyGuide(guide, this.liveGuide);
			for (let i = 0; i < SAMPLES; i++) {
				next.x[i] = p.x; next.y[i] = p.y; next.t[i] = this.time + i * FORECAST_DT;
				if (i === SAMPLES - 1) { next.forceX[i] = 0; next.forceY[i] = 0; break; }
				for (let sub = 0; sub < 3; sub++) {
					const forceOut = sub === 0 ? this.guideForce : null;
					this.integrate(p, DT, route, this.guideStrength, forceOut, null, guide);
					if (!forceOut) continue;
					next.forceX[i] = forceOut.x; next.forceY[i] = forceOut.y;
				}
			}
			pathLength(next);
			next.count = SAMPLES;
			const previous = this.path;
			this.path = next;
			this.sparePath = previous;
			// Commit the plan as the route the beam follows, then hold it for the selected memory.
			// The hold quantises to the refresh period, so a plan is adopted at the nearest refresh
			// boundary instead of drifting by a frame. While the clock stands still (field edits made
			// while paused) the route tracks the edit immediately: the beam is not flying.
			const elapsed = this.time - this.referenceTime;
			if (this.reference.count < 2 || elapsed <= 0 || elapsed >= this.planLag - DT) {
				this.reference.x.set(next.x); this.reference.y.set(next.y);
				this.reference.t.set(next.t); this.reference.s.set(next.s);
				this.reference.count = SAMPLES;
				this.referenceTime = this.time;
				// Re-seat the live anchor onto the new reference with a wide search window.
				resetGuide(this.liveGuide);
			}
			this.referenceAge = this.reference.count > 1 ? this.time - this.referenceTime : 0;
			// A commit re-derives the route from the beam, and a paused edit reprojects it while the beam
			// stands still: re-anchor here so the overlay reports the guidance of the committed route.
			const live = this.guidanceVector(this.particle, this.reference, this.guideStrength, this.liveDebug, this.liveGuide);
			this.liveForce.x = live.x; this.liveForce.y = live.y;
			this.liveDebug.age = this.referenceAge;
			const horizon = next.t[SAMPLES - 1] - next.t[0];
			for (let i = 0; i < this.targets.length; i++) this.targets[i].predicted = this.pathDwell(this.targets[i]) / horizon;
			this.predictedCooling = 0;
			for (let i = 0; i < this.zones.length; i++) this.predictedCooling += this.pathDwell(this.zones[i]) / horizon;
		}

		pathDwell(circle) {
			let dwell = 0;
			const p = this.path;
			for (let i = 1; i < p.count; i++) dwell += circleFraction(p.x[i - 1], p.y[i - 1], p.x[i], p.y[i], circle.x, circle.y, circle.radius) * (p.t[i] - p.t[i - 1]);
			return dwell;
		}

		step() {
			const p = this.particle, ax = p.x, ay = p.y;
			this.integrate(p, DT, this.reference, this.guideStrength, this.liveForce, this.liveDebug, this.liveGuide);
			this.time += DT;
			// The integration steers from the position at the start of the step, so its snapshot trails
			// the beam by that step — a ring drawn from it sat ~1.2 px behind the particle and read as a
			// backwards pull. Re-project and re-aim against the position the player is looking at; the
			// force published here is the one the next step applies, so ring, arrow and readout agree.
			const force = this.guidanceVector(p, this.reference, this.guideStrength, this.liveDebug, this.liveGuide);
			this.liveForce.x = force.x; this.liveForce.y = force.y;
			this.liveDebug.age = this.referenceAge;
			const smoothing = 1 - Math.exp(-DT / 10);
			let balanced = this.time > 14;
			for (let i = 0; i < this.targets.length; i++) {
				const t = this.targets[i];
				const exposure = circleFraction(ax, ay, p.x, p.y, t.x, t.y, t.radius);
				t.actual += (exposure - t.actual) * smoothing;
				if (Math.abs(t.actual / t.desired - 1) > 0.3) balanced = false;
			}
			let exposure = 0;
			for (let i = 0; i < this.zones.length; i++) {
				const z = this.zones[i];
				exposure += circleFraction(ax, ay, p.x, p.y, z.x, z.y, z.radius);
			}
			this.cooling += (exposure - this.cooling) * smoothing;
			this.stableTime = balanced && this.cooling < 0.015 ? this.stableTime + DT : 0;
			this.trailX[this.trailHead] = p.x;
			this.trailY[this.trailHead] = p.y;
			this.trailHead = (this.trailHead + 1) % this.trailX.length;
			this.trailCount = Math.min(this.trailCount + 1, this.trailX.length);
			this.forecastClock += DT;
			if (this.forecastClock < FORECAST_PERIOD) return;
			this.forecastClock -= FORECAST_PERIOD;
			this.predict();
		}
	}
	const api = { Reactor, DT, TAU, circleFraction, reflect };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.ReactorCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
