# Findings and pitfalls

- Keep forecast and live simulation buffers separate. Forecasting must copy the particle into reusable scratch state and must not accumulate live activation or advance the live clock.
- At trajectory crossings, nearest position alone can choose an opposing segment. Score direction agreement as well as distance, and limit guidance acceleration instead of snapping velocity.
- Aiming a guidance vector straight at a look-ahead node pushes an on-track beam forward (thrust, not steering), so every debug vector points along the path. Measure the correction relative to where the beam would coast on its own: a tracking beam then feels ~zero force and only cross-track/speed deviations get pulled back.
- Target influence is dwell time, not entry count. Segment-circle overlap multiplied by timestamp differences makes forecasting less sensitive to sample spacing.
- Preserve classic script loading and guarded CommonJS exports so the same core runs under `file://` and Node tests without a build.
- Keep browser tooling external to the runtime tree. The optional Playwright experiment accepts `BROWSER_EXECUTABLE` for environments where automatic browser downloads are unavailable.
