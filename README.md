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
- Guidance steers the beam onto its **committed route** — the trajectory it announced, held for the selected **route memory** (1.8 s by default, 0 adopts every new prediction immediately). The beam is projected onto that route, aims one **forward aim** interval (100 ms of route arc) ahead of the projection, and only the part of the correction lateral to its velocity is applied, so guidance can steer but never thrust or brake. Tune strength, distance reach, heading-angle fade, forward aim and route memory; set strength or reach to 0 to disable guidance. Enable **Show guidance force vectors** to inspect the amber accelerations used while generating the forecast, the dashed violet committed route, the cross-track line, the ring on the projected route point, the dot on the look-ahead point, the white steering arrow and a numeric readout of route age, off-route distance, heading error and force. Arrow lengths use a square-root scale, so a small force reads as small.

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
- `archive/0.1-worklog.md` … `archive/0.1.6-worklog.md` — implementation and validation records.

Run the dependency-free simulation checks:

```sh
node --test tests/*.test.js
node experiments/guidance-probe.js
```

`experiments/guidance-probe.js` measures the guide deterministic: projection geometry, force direction
against the velocity, route-memory commits and the paired response to a magnet edit.

`experiments/browser-smoke.js` is an optional Playwright smoke test. Install Playwright in a separate tooling directory and expose it with `NODE_PATH`; install its Chromium browser, or supply `BROWSER_EXECUTABLE`. No browser-test packages are required by the application. `SCREENSHOT_PATH` optionally chooses the mobile screenshot destination (default `/tmp/reactor-mobile.png`).

## Prototype boundaries / next work

Scenario solvability and difficulty are **not yet calibrated**. The stable status is implemented, but no known winning control preset is supplied. The next step is deterministic parameter sweeps and playtesting to establish a useful tuning range and a verified solvable scenario.

Guidance is a bounded steering term: it projects the beam onto the committed route, aims a fixed interval of route arc ahead, and applies only the lateral part of that correction — measured over 60 s runs the force never opposes the velocity (maximum force-to-velocity angle exactly 90.00°). Because a plan generated from the live beam is already the beam's ballistic continuation, a reference that always tracks the newest prediction makes zero force a fixed point and the guide can never do visible work; the route memory is what keeps the reference committed, so a field edit produces real cross-track error that guidance then corrects (with the default 1.8 s memory, a magnet polarity flip raises the off-route distance from 0.0 px to 0.8 px and the guide force from 0.17 to 0.33 over the following four seconds, and a forced 15 px deviation decays 13 → 2 px in 1.5 s instead of being adopted at the next refresh). On a beam that already follows its route the force is deliberately near zero (about 0.1 % of the field); the debug readout is the honest way to read it. The guide can hold a route the field roughly supports, but it cannot force a route the field does not: after a large edit the beam adopts the new orbit and guidance yields through its distance fade. Reforecasting is synchronous and swaps reusable path buffers; long-term convergence still needs measurement.

Dwell is integrated exactly along each sampled line segment using its timestamp interval. The live path uses 120 Hz steps; the forecast stores 40 Hz samples. Curvature and within-step reflector kinks are therefore approximated by chords. Target duties, smoothing, and stability thresholds are initial design choices, not final balance settings.

The guide locates its anchor by **movement matching**: it scans every forward-heading-aligned segment of the whole committed route for the spatially nearest one, rather than only the sample scheduled for the beam's own elapsed clock time. Because the field is quasi-periodic, the 14 s forecast can re-enter a region it already visited on an earlier lap; movement matching is what lets a later lap lock onto an earlier one and converge toward a repeating loop, instead of being structurally unable to compare the beam to anything but its own open-ended extrapolation. In practice the default field's unguided lap-to-lap drift (tens to 100+ px) often exceeds the 40 px guide reach, so closure currently depends on two laps already coming close — see `0.1-plan.md` for the suggested field retuning.
