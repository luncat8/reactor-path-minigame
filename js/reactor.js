(function (root) {
	'use strict';
	const DT = 1 / 120;
	const FORECAST_DT = 1 / 40;
	const FORECAST_PERIOD = 0.6;
	const SAMPLES = 561;
	const TAU = Math.PI * 2;
	const MAX_GRAZING_SINE = Math.sin(25 * Math.PI / 180);
	const GUIDE_POSITION_GAIN = 0.5;
	const GUIDE_PHASE_TIME = 0.75;
	const MAX_GUIDE_ACCELERATION = 50;
	const MIN_GUIDE_FORCE = 0.01;
	// The pull aims this far ahead on the loop so it joins and follows the rail instead
	// of braking against the section beside the beam.
	const LOOP_LOOK_AHEAD = 0.1;
	// A lost detection keeps the committed loop this long, so a marginal recurrence
	// flickering around the tolerance does not drop the rail out from under the beam.
	const LOOP_GRACE = 1.2;
	// Loop detection accepts what the field almost supports; the pull acts only inside the
	// player's match tolerances. Detection must be looser than the pull, or chaos growing
	// across the lap keeps tipping the closure over the gate and the rail is dropped.
	const LOOP_DETECT_DISTANCE = 100;
	const LOOP_DETECT_RADIUS2 = LOOP_DETECT_DISTANCE * LOOP_DETECT_DISTANCE;
	const LOOP_DETECT_ANGLE = 45;
	const LOOP_DETECT_COSINE = Math.cos(Math.min(Math.PI / 2, LOOP_DETECT_ANGLE * Math.PI / 180));
	// The closure error is blended into this last fraction of the lap, so the committed
	// rail is one closed curve. Without the stitch the seam (median ~50 px, wider than
	// the pull tolerance) lets the beam cross the junction unguided every lap, and the
	// rail only ever follows the drift instead of correcting it. 0 blends linearly over
	// the whole lap (a gentle bias); a value near 1 concentrates a C1 bend in the tail.
	const LOOP_STITCH_START = 0;
	// An unrelated loop may capture the beam only when the forecast shows the beam
	// arriving at its entry within this window; far-future entries are never committed.
	const LOOP_CAPTURE_WINDOW = 6;
	// Full authority up to this fraction of a tolerance, then a smooth cutoff at 100%:
	// inside the tolerance the guide really pulls, beyond it there is exactly no force.
	const GUIDE_FULL_FACTOR = 0.75;
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
			x: new Float64Array(SAMPLES), y: new Float64Array(SAMPLES),
			vx: new Float64Array(SAMPLES), vy: new Float64Array(SAMPLES), t: new Float64Array(SAMPLES),
			forceX: new Float64Array(SAMPLES), forceY: new Float64Array(SAMPLES), count: 0
		};
	}

	function makeLoop() {
		return {
			x: new Float64Array(SAMPLES), y: new Float64Array(SAMPLES),
			vx: new Float64Array(SAMPLES), vy: new Float64Array(SAMPLES),
			count: 0, start: 0, period: 0, step: FORECAST_DT,
			entryX: 0, entryY: 0, expire: 0
		};
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
			// Experiment-harness flag: skip the display forecast pass (guided route,
			// predicted duties). Loop detection, commitment, and live dynamics are
			// bit-identical; batch searches run ~10x faster with it set.
			this.skipDisplayForecast = false;
			this.scratch = { x: 0, y: 0, vx: 0, vy: 0 };
			this.particle = { x: 0, y: 0, vx: 0, vy: 0 };
			this.guideForce = { x: 0, y: 0 };
			this.forecastForce = { x: 0, y: 0 };
			this.loop = makeLoop();
			this.railEntry = { x: 0, y: 0, vx: 0, vy: 0 };
			this.anchor = { segment: -1, position: 0, distance: 0, angle: 0 };
			this.foot = { x: 0, y: 0, vx: 0, vy: 0 };
			this.aim = { x: 0, y: 0, vx: 0, vy: 0 };
		this.pair = { found: false, i: 0, j: 0, score: Infinity };
		this.alternatePair = { found: false, i: 0, j: 0, score: Infinity };
			this.liveForce = { x: 0, y: 0 };
			this.liveDebug = {
				valid: false, engaged: false, tx: 0, ty: 0, tvx: 0, tvy: 0,
				distance: 0, angle: 0, speedError: 0, magnitude: 0, period: 0
			};
			this.trailX = new Float64Array(900);
			this.trailY = new Float64Array(900);
			this.reset();
		}

		reset() {
			this.time = 0;
			this.guideStrength = 0.9;
			this.guideDistance = 40;
			this.guideDirection = 30;
			this.guideVelocity = 0.35;
			this.guidePeriod = 2;
			this.forecastClock = 0;
			this.forecastInterval = FORECAST_PERIOD;
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
		this.liveForce.x = 0;
		this.liveForce.y = 0;
		this.liveDebug.valid = false;
		this.liveDebug.engaged = false;
		this.loop.count = 0;
		this.path = makePath();
		this.proposalPath = makePath();
		this.heldPath = makePath();
		this.predict();
		}

	// A loop candidate is a near-recurrence anchored at the beam: the earlier state lies
	// within the detection radius of the beam's current position, and a later forecast
	// state returns to it inside the detection tolerances — the beam's own next lap,
	// closed by the field. The rail therefore rolls with the beam and evolves smoothly
	// with the field. `alternate` tracks the best candidate anchored elsewhere, so a
	// passing loop can still capture the beam once the held rail expires.
	findLoopPair(route) {
		const pair = this.pair;
		const alternate = this.alternatePair;
		pair.found = false;
		pair.score = Infinity;
		alternate.found = false;
		alternate.score = Infinity;
		if (route.count < 2 || this.guideDistance <= 0 || this.guideDirection <= 0) return pair;
		const reach = LOOP_DETECT_DISTANCE;
		const anchorX = this.particle.x, anchorY = this.particle.y;
		let first = 1;
		for (let i = 0; i < route.count; i++) {
			if (first <= i) first = i + 1;
			while (first < route.count && route.t[first] - route.t[i] < this.guidePeriod) first++;
			if (first >= route.count) break;
			const x = route.x[i], y = route.y[i];
			const vx = route.vx[i], vy = route.vy[i];
			const speed = Math.hypot(vx, vy);
			if (speed < 1e-8) continue;
			const beamX = x - anchorX, beamY = y - anchorY;
			const atBeam = beamX * beamX + beamY * beamY < LOOP_DETECT_RADIUS2;
			for (let j = first; j < route.count; j++) {
				const dx = route.x[j] - x;
				if (dx >= reach || dx <= -reach) continue;
				const dy = route.y[j] - y;
				if (dy >= reach || dy <= -reach) continue;
				const distance2 = dx * dx + dy * dy;
				if (distance2 >= LOOP_DETECT_RADIUS2) continue;
				const tvx = route.vx[j], tvy = route.vy[j];
				const targetSpeed = Math.hypot(tvx, tvy);
				if (targetSpeed < 1e-8) continue;
				if ((vx * tvx + vy * tvy) / (speed * targetSpeed) < LOOP_DETECT_COSINE) continue;
				const speedX = tvx - vx, speedY = tvy - vy;
				const score = distance2 + (speedX * speedX + speedY * speedY) * GUIDE_PHASE_TIME * GUIDE_PHASE_TIME;
				if (atBeam) {
					if (score >= pair.score) continue;
					pair.found = true;
					pair.score = score;
					pair.i = i;
					pair.j = j;
				} else {
					if (score >= alternate.score) continue;
					alternate.found = true;
					alternate.score = score;
					alternate.i = i;
					alternate.j = j;
				}
			}
		}
		return pair;
	}

	// Stitch the seam: fade the closure error in so sample count - 1 lands exactly on
	// sample 0 with matching velocity. The rail becomes a closed curve the guide can
	// hold with pull tolerance alone.
	stitchSeam(rail, count) {
		const intervals = count - 1;
		const blendStart = LOOP_STITCH_START > 0 ? Math.min(Math.max(1, Math.round(intervals * LOOP_STITCH_START)), intervals - 1) : 0;
		const gapX = rail.x[0] - rail.x[intervals];
		const gapY = rail.y[0] - rail.y[intervals];
		const gapVX = rail.vx[0] - rail.vx[intervals];
		const gapVY = rail.vy[0] - rail.vy[intervals];
		for (let k = blendStart; k <= intervals; k++) {
			const u = (k - blendStart) / (intervals - blendStart);
			const f = LOOP_STITCH_START > 0 ? smoothstep(u) : u;
			rail.x[k] += gapX * f;
			rail.y[k] += gapY * f;
			rail.vx[k] += gapVX * f;
			rail.vy[k] += gapVY * f;
		}
	}

	commitLoop(route, i, j) {
		const loop = this.loop;
		const count = j - i + 1;
		for (let k = 0; k < count; k++) {
			loop.x[k] = route.x[i + k];
			loop.y[k] = route.y[i + k];
			loop.vx[k] = route.vx[i + k];
			loop.vy[k] = route.vy[i + k];
		}
		loop.count = count;
		loop.start = route.t[i];
		loop.period = route.t[j] - route.t[i];
		loop.step = loop.period / (count - 1);
		this.stitchSeam(loop, count);
		loop.entryX = loop.x[0];
		loop.entryY = loop.y[0];
		loop.expire = this.time + LOOP_GRACE;
	}

		// The committed lap is a closed rail: interval k connects sample k to sample (k + 1),
		// and the last interval wraps around to sample 0, closing the loop.
		loopStateAt(position, out) {
			const loop = this.loop;
			const intervals = loop.count - 1;
			let f = position % intervals;
			if (f < 0) f += intervals;
			const k = f | 0;
			const u = f - k;
			const a = k;
			const b = k === intervals - 1 ? 0 : k + 1;
			out.x = loop.x[a] + (loop.x[b] - loop.x[a]) * u;
			out.y = loop.y[a] + (loop.y[b] - loop.y[a]) * u;
			out.vx = loop.vx[a] + (loop.vx[b] - loop.vx[a]) * u;
			out.vy = loop.vy[a] + (loop.vy[b] - loop.vy[a]) * u;
			return out;
		}

		// Nearest compatible section of the loop: the beam is only ever pulled toward a
		// section it is already close to and already moving along, so a crossing branch
		// with the wrong direction can never capture it. Sections at the heading limit
		// must be clearly nearer than a well-aligned one to win.
		findLoopAnchor(rail, p, out) {
			const intervals = rail.count - 1;
			out.segment = -1;
			if (intervals < 1) return false;
			const speed = Math.hypot(p.vx, p.vy);
			if (speed < 1e-8) return false;
			const angleLimit = Math.min(Math.PI / 2, this.guideDirection * Math.PI / 180);
			const minimumCosine = Math.cos(angleLimit);
			let best = Infinity;
			for (let k = 0; k < intervals; k++) {
				const a = k;
				const b = k === intervals - 1 ? 0 : k + 1;
				const dx = rail.x[b] - rail.x[a], dy = rail.y[b] - rail.y[a];
				const length2 = dx * dx + dy * dy;
				if (length2 < 1e-12) continue;
				const u = clamp(((p.x - rail.x[a]) * dx + (p.y - rail.y[a]) * dy) / length2, 0, 1);
				const rx = rail.x[a] + dx * u - p.x;
				const ry = rail.y[a] + dy * u - p.y;
				const distance2 = rx * rx + ry * ry;
				if (distance2 >= best) continue;
				const vx = rail.vx[a] + (rail.vx[b] - rail.vx[a]) * u;
				const vy = rail.vy[a] + (rail.vy[b] - rail.vy[a]) * u;
				const loopSpeed = Math.hypot(vx, vy);
				if (loopSpeed < 1e-8) continue;
				const cosine = (p.vx * vx + p.vy * vy) / (speed * loopSpeed);
				if (cosine <= 0 || cosine < minimumCosine) continue;
				const angle = Math.acos(clamp(cosine, -1, 1));
				const score = distance2 * (1 + 3 * (angle / angleLimit) * (angle / angleLimit));
				if (score >= best) continue;
				best = score;
				out.segment = k;
				out.position = k + u;
				out.distance = Math.sqrt(distance2);
				out.angle = angle;
			}
			return out.segment >= 0;
		}

		// The committed loop works as a magnetic guide rail: a bounded lateral force returns
		// the beam to the nearest compatible section of the loop while velocity matching
		// adopts the local speed and heading, so laps repeat and the orbit closes. The pull
		// is zero outside the match tolerances — the guide only completes loops the field
		// almost supports, it never drags the beam onto an impossible orbit.
		guidanceVector(p, guidance, debug) {
			const force = this.guideForce;
			force.x = 0;
			force.y = 0;
			if (debug) { debug.valid = false; debug.engaged = false; debug.magnitude = 0; }
			const loop = this.loop;
			if (loop.count < 2) return force;
			if (debug) debug.valid = true;
			if (debug) debug.period = loop.period;
			if (guidance <= 0 || this.guideDistance <= 0 || this.guideDirection <= 0) return force;
			const anchor = this.findLoopAnchor(this.loop, p, this.anchor);
			if (debug && anchor) { debug.distance = this.anchor.distance; debug.angle = this.anchor.angle; }
			if (!anchor) return force;
			if (debug) debug.engaged = this.anchor.distance < this.guideDistance;
			if (this.anchor.distance >= this.guideDistance) return force;
			const foot = this.loopStateAt(this.anchor.position, this.foot);
			const aim = this.loopStateAt(this.anchor.position + LOOP_LOOK_AHEAD / loop.step, this.aim);
			if (debug) {
				debug.tx = aim.x; debug.ty = aim.y;
				debug.tvx = aim.vx; debug.tvy = aim.vy;
				debug.speedError = Math.hypot(aim.vx - p.vx, aim.vy - p.vy);
			}
			const angleLimit = Math.min(Math.PI / 2, this.guideDirection * Math.PI / 180);
			const distanceFactor = 1 - smoothstep((this.anchor.distance / this.guideDistance - GUIDE_FULL_FACTOR) / (1 - GUIDE_FULL_FACTOR));
			const directionFactor = 1 - smoothstep((this.anchor.angle / angleLimit - GUIDE_FULL_FACTOR) / (1 - GUIDE_FULL_FACTOR));
			let fx = (foot.x - p.x) * GUIDE_POSITION_GAIN + (aim.vx - p.vx) * this.guideVelocity;
			let fy = (foot.y - p.y) * GUIDE_POSITION_GAIN + (aim.vy - p.vy) * this.guideVelocity;
			const scale = guidance * distanceFactor * directionFactor;
			fx *= scale;
			fy *= scale;
			const length = Math.hypot(fx, fy);
			const magnitude = Math.min(MAX_GUIDE_ACCELERATION, length);
			if (debug) debug.magnitude = magnitude >= MIN_GUIDE_FORCE ? magnitude : 0;
			if (magnitude < MIN_GUIDE_FORCE) return force;
			const limit = magnitude / length;
			force.x = fx * limit;
			force.y = fy * limit;
			return force;
		}

		integrate(p, dt, guidance, forceOut, debug) {
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
			if (guidance > 0) {
				const force = this.guidanceVector(p, guidance, debug);
				fx += force.x; fy += force.y;
				if (forceOut) { forceOut.x = force.x; forceOut.y = force.y; }
			}
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

		// `from` forecasts an arbitrary state (the held rail's entry) instead of the live beam,
		// and `samples` caps the horizon to the length actually needed.
		forecastInto(next, guidance, from, samples) {
			const p = this.scratch;
			const count = samples || SAMPLES;
			Object.assign(p, from || this.particle);
			for (let i = 0; i < count; i++) {
				next.x[i] = p.x; next.y[i] = p.y;
				next.vx[i] = p.vx; next.vy[i] = p.vy;
				next.t[i] = this.time + i * FORECAST_DT;
				if (i === count - 1) { next.forceX[i] = 0; next.forceY[i] = 0; break; }
				for (let sub = 0; sub < 3; sub++) {
					const forceOut = sub === 0 ? this.forecastForce : null;
					this.integrate(p, DT, guidance, forceOut, null);
					if (!forceOut) continue;
					next.forceX[i] = forceOut.x;
					next.forceY[i] = forceOut.y;
				}
			}
			next.count = count;
		}

		// Transport the held lap through an edited field: propagate the rail's own entry state
		// for one period and keep the result when the beam can still ride it. Re-deriving from
		// the beam's live state instead searched a forecast the guide has already pulled off the
		// unguided trajectory, so it latched onto a different lap family and threw the beam off
		// the rail — a sub-pixel magnet nudge used to reshape the whole orbit.
		retainLoop() {
			const loop = this.loop;
			const intervals = loop.count - 1;
			if (intervals < 2) return false;
			const entry = this.railEntry;
			entry.x = loop.x[0]; entry.y = loop.y[0];
			entry.vx = loop.vx[0]; entry.vy = loop.vy[0];
			const held = this.heldPath;
			this.forecastInto(held, 0, entry, intervals + 1);
			this.stitchSeam(held, held.count);
			// Validity is the pull's own tolerance test on the stitched rail, not the lap's
			// seam: what matters is that the beam still meets the transported rail inside its
			// tolerances. An edit that moves the orbit out from under the beam fails here, and
			// the search re-derives from the beam's own next lap instead.
			if (!this.findLoopAnchor(held, this.particle, this.anchor)) return false;
			if (this.anchor.distance >= this.guideDistance) return false;
			this.commitLoop(held, 0, intervals);
			return true;
		}

		// Commit hysteresis. While the beam is on the rail the shape is frozen — only
		// the grace timer is refreshed — so a better-scoring loop family elsewhere cannot
		// hijack the ride. Re-fitting happens once the beam has stayed off the rail past
		// grace, when nothing is held yet, or immediately when `force` is set (a player
		// field edit), which follows the changed field even mid-ride.
		commitDecision(force) {
			const loop = this.loop;
			const pair = this.pair, alternate = this.alternatePair;
			if (loop.count > 1) {
				const riding = this.findLoopAnchor(this.loop, this.particle, this.anchor) && this.anchor.distance < this.guideDistance;
				if (riding && !force) {
					loop.expire = this.time + LOOP_GRACE;
					return;
				}
				// A field edit keeps the held lap when the beam can still ride its transported
				// version, so the rail follows the edit instead of being re-fitted from scratch.
				if (force && this.retainLoop()) return;
				if (!force && this.time <= loop.expire) return;
				if (pair.found) {
					this.commitLoop(this.proposalPath, pair.i, pair.j);
					return;
				}
				if (riding) {
					// Field changed but the new field offers no fresh lap near the beam yet:
					// keep the ride alive briefly instead of dropping the rail outright.
					loop.expire = this.time + LOOP_GRACE;
					return;
				}
				if (alternate.found && this.proposalPath.t[alternate.i] - this.time < LOOP_CAPTURE_WINDOW) {
					this.commitLoop(this.proposalPath, alternate.i, alternate.j);
					return;
				}
				loop.count = 0;
				return;
			}
			if (pair.found) {
				this.commitLoop(this.proposalPath, pair.i, pair.j);
				return;
			}
			if (alternate.found && this.proposalPath.t[alternate.i] - this.time < LOOP_CAPTURE_WINDOW) {
				this.commitLoop(this.proposalPath, alternate.i, alternate.j);
			}
		}

		predict(force) {
			// Two reusable passes with different jobs. The first pass is unguided: it shows what
			// the field alone would do, and its best near-recurrence is the loop the field almost
			// supports — detection never depends on the guide's own limited authority. The second
			// pass follows the committed loop, so the displayed forecast matches the forces the
			// beam will actually feel. `force` re-derives the rail after a player field edit.
			this.forecastInto(this.proposalPath, 0);
			this.findLoopPair(this.proposalPath);
			this.commitDecision(force);
			if (this.skipDisplayForecast) return;
			this.forecastInto(this.path, this.guideStrength);
			const live = this.guidanceVector(this.particle, this.guideStrength, this.liveDebug);
			this.liveForce.x = live.x; this.liveForce.y = live.y;
			const horizon = this.path.t[SAMPLES - 1] - this.path.t[0];
			for (let i = 0; i < this.targets.length; i++) this.targets[i].predicted = this.pathDwell(this.targets[i]) / horizon;
			this.predictedCooling = 0;
			for (let i = 0; i < this.zones.length; i++) this.predictedCooling += this.pathDwell(this.zones[i]) / horizon;
		}

		pathDwell(circle) {
			let dwell = 0;
			const p = this.path;
			for (let i = 1; i < p.count; i++) {
				dwell += circleFraction(p.x[i - 1], p.y[i - 1], p.x[i], p.y[i], circle.x, circle.y, circle.radius) *
					(p.t[i] - p.t[i - 1]);
			}
			return dwell;
		}

		step() {
			const p = this.particle, ax = p.x, ay = p.y;
			this.integrate(p, DT, this.guideStrength, this.liveForce, this.liveDebug);
			this.time += DT;
			const force = this.guidanceVector(p, this.guideStrength, this.liveDebug);
			this.liveForce.x = force.x; this.liveForce.y = force.y;
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
			if (this.forecastClock < this.forecastInterval) return;
			this.forecastClock -= this.forecastInterval;
			this.predict();
		}
	}

	const api = { Reactor, DT, TAU, FORECAST_PERIOD, circleFraction, reflect };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.ReactorCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
