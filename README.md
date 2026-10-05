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
- Guidance adjusts a soft attraction/alignment to nearby forward-directed segments of the preceding forecast. It has no effect when motion is perpendicular or opposed to the local forecast; zero disables it.

## Read the chamber

- Thin cyan line: finite **14-second forecast**, refreshed every 0.6 simulation seconds.
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
- `archive/0.1-worklog.md` and `archive/0.1.1-worklog.md` — implementation and validation records.

Run the dependency-free simulation checks:

```sh
node --test tests/*.test.js
```

`experiments/browser-smoke.js` is an optional Playwright smoke test. Install Playwright in a separate tooling directory and expose it with `NODE_PATH`; install its Chromium browser, or supply `BROWSER_EXECUTABLE`. No browser-test packages are required by the application. `SCREENSHOT_PATH` optionally chooses the mobile screenshot destination (default `/tmp/reactor-mobile.png`).

## Prototype boundaries / next work

Scenario solvability and difficulty are **not yet calibrated**. The stable status is implemented, but no known winning control preset is supplied. The next step is deterministic parameter sweeps and playtesting to establish a useful tuning range and a verified solvable scenario.

Guidance chooses nearby forward-aligned segments, scales force by directional agreement, and skips perpendicular or opposed travel. Reforecasting is synchronous and swaps reusable path buffers; the force is bounded, but visual forecast continuity and long-term convergence still need measurement. Future guidance feeds back the previous prediction, so the forecast is an estimate, not a promise of the live path.

Dwell is integrated exactly along each sampled line segment using its timestamp interval. The live path uses 120 Hz steps; the forecast stores 40 Hz samples. Curvature and within-step reflector kinks are therefore approximated by chords. Target duties, smoothing, and stability thresholds are initial design choices, not final balance settings.
