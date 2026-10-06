# Reactor path minigame

A dependency-free HTML/JavaScript experiment: tune a single beam's evolving orbit with magnets and grazing-angle reflectors. Activate three targets evenly while avoiding transparent cooling zones.

## Run

Open **`index.html`** in a modern browser. No installation, build, network access, or server is required.

For a local HTTP preview, optionally run:

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

## Controls

- Select M1–M4 or R1–R2 on the canvas or in the instrument panel.
- Drag inside a magnet to move it around the chamber frame. Drag outside the selected instrument to rotate it; the orientation slider and mouse wheel also work. Magnets have strength and polarity controls.
- With the canvas focused: **Q / E** rotates; **Right / Down** moves the selected magnet clockwise; **Left / Up** moves it counterclockwise; **Space** pauses.
- Reflectors stay in fixed positions and rotate. They reflect crossings below 25° relative to their surface; steeper crossings pass through.
- **Pause**, **Step**, and **Reset experiment** support inspection. Field edits update the forecast even while paused. Reset preserves pause state.
- Guidance steers the beam onto its **committed route** — the trajectory it announced, held for the selected **route memory** (1.8 s by default, 0 adopts every new prediction immediately). Each step the beam is projected onto the route's **true nearest point** (interpolated between samples, not snapped to a stored node) and aims one **forward aim** interval (100 ms of route arc) beyond it; only the part of that correction lateral to its velocity is applied, so guidance can steer but never thrust, brake or point backwards. Tune strength, distance reach, heading-angle fade, forward aim and route memory; set strength or reach to 0 to disable guidance.
- Enable **Show guidance force vectors** to inspect the guide's own geometry: the **green ring** is the nearest route point — the target the pull works toward — the **amber dot** is the look-ahead point, the dashed line is the cross-track error, the amber vectors are the accelerations used while generating the forecast, the white arrow is the live pull (drawn only above 0.25, since below that it is tracking dust) and the readout prints route age, off-route distance, heading error and the exact force. The overlay is refreshed after each simulation step, so the ring marks where the beam is now instead of trailing it by a step. Arrow lengths use a square-root scale, so a small force reads as small.

## Read the chamber

- Thin cyan line: finite **14-second forecast**, refreshed every 0.6 simulation seconds. In debug mode a dashed violet line shows the committed route the guide actually steers against.
- Bright line: recent actual beam history; bright dot: live particle.
- Target bars next to the circles: **predicted percentage deviation** from each target's requested duty cycle.
- Side panel: **live activation deviation**, exponentially smoothed with a 10-second time constant. A zero deviation means the target receives its requested 6.5% beam occupancy. Bars' midpoint marks that goal.
- Hatched amber zones: cooling exposure; they do not reflect the particle.
- Stability requires all live targets within ±30% of their requested activation and cooling exposure below 1.5%, sustained for eight seconds after the initial 14-second warmup.

This is a gameplay field model, not a physical reactor simulation. A weak anisotropic restoring field, soft boundary confinement, and gentle speed regulation keep the experiment in the chamber. Magnet orientation modulates a softened directional field; reversing polarity reverses its force.

## Development

- `draft.txt` — original concept.
- `0.1-plan.md` — standalone development plan, including follow-up work.
- `js/reactor.js` — deterministic fixed-step simulation, forecast buffers, collision and dwell geometry; also exported for Node.
- `js/app.js` — canvas renderer, controls, and fixed-step scheduler.
- `archive/0.1-worklog.md` … `archive/0.1.4-worklog.md` — implementation and validation records.

Run the dependency-free simulation checks:

```sh
node --test tests/*.test.js
node experiments/guidance-probe.js
```

`experiments/guidance-probe.js` measures the guide deterministically: nearest-point placement, the
force direction against the ring it draws and against the velocity, route-memory behaviour under
player-like magnet drags, deviation decay and the paired response to a polarity flip.

`experiments/browser-smoke.js` is an optional Playwright smoke test. Install Playwright in a separate tooling directory and expose it with `NODE_PATH`; install its Chromium browser, or supply `BROWSER_EXECUTABLE`. No browser-test packages are required by the application. `SCREENSHOT_PATH` optionally chooses the mobile screenshot destination (default `/tmp/reactor-mobile.png`).

## Prototype boundaries / next work

Scenario solvability and difficulty are **not yet calibrated**. The stable status is implemented, but no known winning control preset is supplied. The next step is deterministic parameter sweeps and playtesting to establish a useful tuning range and a verified solvable scenario.

Guidance is a bounded steering term: the beam is projected onto the committed route at its true nearest point, one forward-aim interval of arc beyond that point is the aim, and only the lateral part of that correction is applied. The force is therefore perpendicular to the beam's velocity by construction — measured over 120 s of play with a magnet dragged every 5 s, `|cos(F,v)|` never exceeded 3e-13, so thrust, braking and any backwards pull are impossible rather than merely gated, and a beam sitting exactly on its route needs exactly no correction. The debug ring is the same nearest point, so the arrow points from the beam at the ring: over the same run the drawn arrows sat 2.2° off the ring direction on average (median 1.5°), with rare corner-overshoot frames where the heading correction dominates and the readout's heading error explains the difference.

Because a plan generated from the live beam is already the beam's ballistic continuation, a reference that always tracks the newest prediction makes zero force a fixed point and the guide can never do visible work; the route memory is what keeps the reference committed, so a field edit produces real cross-track error that guidance then corrects. With the default 1.8 s memory a magnet polarity flip leaves 0.9 px of off-route distance and 0.36 of force over the following 2 s (with memory 0 the edit is adopted at the next refresh and the error is 0.0 px), and a forced 15 px deviation decays 12.9 → 2.1 px in 1.5 s while the route is held, against 12.9 → 0.0 px in 0.25 s with memory off. Working magnet drags leave the ring 0.53 px off the beam on average (max 13.7 px). On a beam that already follows its route the force is deliberately near zero (about 0.3 % of the field), so the arrow is skipped below 0.25 and the readout is the honest way to read it. The guide can hold a route the field roughly supports, but it cannot force a route the field does not: after a large edit the beam adopts the new orbit and guidance yields through its distance fade. Reforecasting is synchronous and swaps reusable path buffers; long-term convergence still needs measurement.

Dwell is integrated exactly along each sampled line segment using its timestamp interval. The live path uses 120 Hz steps; the forecast stores 40 Hz samples. Curvature and within-step reflector kinks are therefore approximated by chords. Target duties, smoothing, and stability thresholds are initial design choices, not final balance settings.
