/**
 * ================================================================
 * WILAN SUN TRACKER — app.js
 * Film Production Location Scouting Tool
 *
 * Module map:
 *   state          — Single source of truth for all sensor data
 *   dom            — Cached DOM element references
 *   cameraModule   — Rear-facing camera stream via getUserMedia
 *   gpsModule      — Real-time coordinates via Geolocation API
 *   compassModule  — Device orientation (iOS 13+ permission pattern)
 *   sunModule      — PLACEHOLDER for SunCalc.js integration
 *   uiModule       — All DOM update functions (no logic here)
 *   saveModule     — PLACEHOLDER for Supabase + Notion + ClickUp
 *   permModule     — Orchestrates all permission requests
 *   App            — Public API exposed on window for HTML onclicks
 * ================================================================
 */

'use strict';


// ================================================================
// SUPABASE CONFIG
// The publishable key is safe to ship in client-side code — RLS
// on the database restricts what the anon role can read/write.
// ================================================================
const SUPABASE_URL = 'https://lcfuadtgmfcvmpepjdyi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_dPwlThcVVsFb4rQtG6B26w_EH4QuWYy';

// Lazy singleton — created on first save, not at page load
let _db = null;
function getDB() {
  if (!_db) _db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return _db;
}


// ================================================================
// STATE
// One flat object — mutated in place, read by uiModule to render.
// ================================================================
const state = {
  coords:   null,    // { latitude, longitude, accuracy } from GPS
  heading:  null,    // 0–360 degrees, 0 = North, from device compass
  sun: {
    azimuth:   null, // 0–360 degrees from North (SunCalc)
    elevation: null, // degrees above horizon
  },
  moon: {
    azimuth:      null,
    elevation:    null,
    illumination: null, // 0–1 fraction
    phase:        null, // 0–1 (0/1 = new, 0.5 = full)
    phaseName:    null,
    phaseEmoji:   null,
    rise:         null, // Date | null
    set:          null,
  },
  planets:          [],   // [{ name, azimuth, elevation }] — above horizon only
  tilt:             null, // camera elevation angle (deg): 0=horizontal, 90=straight up
  gpsWatchId:       null,
  compassHandler:   null,
  permissionsGranted: false,
};


// ================================================================
// DOM
// Cached once at script parse time — avoids repeated querySelector.
// ================================================================
const dom = {
  video:               document.getElementById('camera-feed'),

  // Status dots in the header
  camDot:              document.getElementById('cam-dot'),
  gpsDot:              document.getElementById('gps-dot'),
  compassDot:          document.getElementById('compass-dot'),
  compassBanner:       document.getElementById('compass-banner'),

  // Permission gate
  permissionSection:   document.getElementById('permission-section'),
  btnPermissions:      document.getElementById('btn-permissions'),
  permBtnIcon:         document.getElementById('perm-btn-icon'),
  permBtnText:         document.getElementById('perm-btn-text'),
  permissionError:     document.getElementById('permission-error'),

  // Data card (shown after permissions)
  dataSection:         document.getElementById('data-section'),
  latDisplay:          document.getElementById('lat-display'),
  lngDisplay:          document.getElementById('lng-display'),
  accuracyDisplay:     document.getElementById('accuracy-display'),
  headingDisplay:      document.getElementById('heading-display'),
  sunAzimuthDisplay:   document.getElementById('sun-azimuth-display'),
  sunElevationDisplay: document.getElementById('sun-elevation-display'),
  timestampDisplay:    document.getElementById('timestamp-display'),

  // AR overlay widgets
  compassCardinal:     document.getElementById('compass-cardinal'),
  compassDegrees:      document.getElementById('compass-degrees'),
  sunDirectionWrap:    document.getElementById('sun-direction-wrap'),
  sunArrow:            document.getElementById('sun-arrow'),
  sunDirectionLabel:   document.getElementById('sun-direction-label'),

  // Moon data
  moonAzimuthDisplay:   document.getElementById('moon-azimuth-display'),
  moonElevationDisplay: document.getElementById('moon-elevation-display'),
  moonPhaseEmoji:       document.getElementById('moon-phase-emoji'),
  moonPhaseName:        document.getElementById('moon-phase-name'),
  moonIllumination:     document.getElementById('moon-illumination'),
  moonRiseDisplay:      document.getElementById('moon-rise-display'),
  moonSetDisplay:       document.getElementById('moon-set-display'),
  moonIllumBar:         document.getElementById('moon-illum-bar'),

  // Moon AR arrow
  moonDirectionWrap:    document.getElementById('moon-direction-wrap'),
  moonArrow:            document.getElementById('moon-arrow'),
  moonDirectionLabel:   document.getElementById('moon-direction-label'),

  // Planets (Sky tab)
  planetsList:          document.getElementById('planets-list'),
  planetsEmpty:         document.getElementById('planets-empty'),
  skyCanvas:            document.getElementById('sky-canvas'),
  arCanvas:             document.getElementById('ar-canvas'),

  // Light schedule (Scout tab)
  lightScheduleSection: document.getElementById('light-schedule-section'),
  lightScheduleRow:     document.getElementById('light-schedule-row'),

  // Save button (Scout tab)
  saveBtnIcon:          document.getElementById('save-btn-icon'),
  saveBtnText:          document.getElementById('save-btn-text'),
  btnSave:              document.getElementById('btn-save'),
};


// ================================================================
// TAB MODULE
// Switches between Scout / Moon / Sky panels.
// All sensor modules keep running in the background regardless of
// which tab is active — only the visible panel changes.
// ================================================================
const tabModule = {

  _tabs: ['scout', 'moon', 'sky'],

  switch(name) {
    this._tabs.forEach(tab => {
      const isActive = tab === name;

      // Tab button — active: amber underline, inactive: grey
      const btn = document.getElementById(`tab-btn-${tab}`);
      btn.classList.toggle('text-amber-400',    isActive);
      btn.classList.toggle('border-amber-400',  isActive);
      btn.classList.toggle('text-slate-500',    !isActive);
      btn.classList.toggle('border-transparent',!isActive);

      // Tab panel — show / hide
      document.getElementById(`tab-panel-${tab}`).classList.toggle('hidden', !isActive);
    });
    if (name === 'sky') skyChartModule.refresh();
  },
};


// ================================================================
// CAMERA MODULE
// Streams the rear-facing camera into the <video> background.
//
// `facingMode: { ideal: 'environment' }` prefers the back camera
// but gracefully falls back to front if no back camera exists
// (e.g. a laptop webcam during desktop testing).
//
// Resolution and frame-rate are capped at 720p / 30fps to balance
// AR visual quality against battery drain on mobile.
// ================================================================
const cameraModule = {

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('[Camera] getUserMedia not supported.');
      uiModule.setDot(dom.camDot, 'error');
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode:  { ideal: 'environment' },
          width:       { ideal: 1280, max: 1920 },
          height:      { ideal: 720,  max: 1080 },
          frameRate:   { ideal: 30,   max: 30   },
        },
        audio: false,
      });

      dom.video.srcObject = stream;

      // `loadedmetadata` fires before the first frame is decoded — safer
      // than `canplay` for kicking off play() to avoid iOS NotAllowedError.
      await new Promise(resolve =>
        dom.video.addEventListener('loadedmetadata', resolve, { once: true })
      );
      await dom.video.play();

      uiModule.setDot(dom.camDot, 'active');
      console.log('[Camera] Stream active.');
      return true;

    } catch (err) {
      // NotAllowedError  — user denied permission
      // NotFoundError    — no camera found
      // OverconstrainedError — constraints couldn't be met (rare)
      console.error('[Camera]', err.name, '—', err.message);
      uiModule.setDot(dom.camDot, 'error');
      return false;
    }
  },

  stop() {
    dom.video.srcObject?.getTracks().forEach(t => t.stop());
    dom.video.srcObject = null;
    uiModule.setDot(dom.camDot, 'idle');
  },
};


// ================================================================
// GPS MODULE
// `watchPosition` pushes updates whenever the device moves or when
// a more accurate fix becomes available. It is throttled by the OS
// on mobile (typically 1–4 s between updates) so it is not a major
// battery concern with `enableHighAccuracy: true`.
//
// If you prefer pure battery savings over live tracking, replace
// watchPosition with a setInterval + getCurrentPosition at ~10 s.
// ================================================================
const gpsModule = {

  start() {
    if (!('geolocation' in navigator)) {
      console.warn('[GPS] Geolocation API not supported.');
      uiModule.setDot(dom.gpsDot, 'error');
      return false;
    }

    state.gpsWatchId = navigator.geolocation.watchPosition(
      pos   => this._onSuccess(pos),
      err   => this._onError(err),
      {
        enableHighAccuracy: true,  // Use GPS chip vs. Wi-Fi/cell tower estimate
        maximumAge:         5_000, // Accept a cached position up to 5 s old
        timeout:            15_000, // Fail after 15 s without a fix
      }
    );

    console.log('[GPS] Watching position, ID:', state.gpsWatchId);
    return true;
  },

  stop() {
    if (state.gpsWatchId !== null) {
      navigator.geolocation.clearWatch(state.gpsWatchId);
      state.gpsWatchId = null;
    }
    uiModule.setDot(dom.gpsDot, 'idle');
  },

  _onSuccess(position) {
    state.coords = {
      latitude:  position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy:  position.coords.accuracy,    // metres
    };

    uiModule.setDot(dom.gpsDot, 'active');
    uiModule.updateGPS(state.coords);

    // Recalculate all celestial data on every GPS update.
    // Every module throttles internally — rapid GPS ticks are cheap.
    const { latitude: lat, longitude: lng } = state.coords;
    sunModule.update(lat, lng);
    moonModule.update(lat, lng);
    planetsModule.update(lat, lng);
    goldenHourModule.update(lat, lng);
    skyChartModule.update(lat, lng);
    arOverlayModule.update(lat, lng);
  },

  _onError(err) {
    const msg = {
      1: 'Location permission denied. Enable it in device Settings.',
      2: 'Position unavailable. Is GPS enabled?',
      3: 'GPS timed out. Move to an open area and retry.',
    }[err.code] ?? err.message;

    console.error('[GPS]', msg);
    uiModule.setDot(dom.gpsDot, 'error');
  },
};


// ================================================================
// COMPASS MODULE
//
// ── iOS 13+ requires DeviceOrientationEvent.requestPermission() ──
// This is an async method that MUST be called synchronously inside
// a user-gesture handler (e.g. a button click). Calling it outside
// a gesture context will either silently fail or throw a TypeError.
//
// Android does NOT have this method — permission is implicit —
// so we check for its existence before calling it.
//
// ── Heading source priority ──────────────────────────────────────
// 1. `webkitCompassHeading` (iOS) — 0–360°, magnetic North, always
//    corrected for device orientation. Most reliable on iPhone/iPad.
// 2. `deviceorientationabsolute` alpha (Chrome Android) — 0–360°,
//    true North if the device has a magnetometer.
// 3. `deviceorientation` alpha (fallback) — may be relative to the
//    initial orientation, not North. Less reliable.
//
// ── Battery note ─────────────────────────────────────────────────
// The OS throttles orientation events to ~60 Hz. We further cap
// DOM updates to 10 Hz (100 ms) since the compass needle animation
// CSS transition already smoothes the visual.
// ================================================================
const compassModule = {

  async requestPermission() {
    // iOS 13+ gate
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      let response;
      try {
        response = await DeviceOrientationEvent.requestPermission();
      } catch (err) {
        // Thrown when called outside a user gesture
        console.error('[Compass] requestPermission() must be called in a user gesture:', err.message);
        uiModule.setDot(dom.compassDot, 'error');
        uiModule.showCompassBanner();
        return false;
      }

      if (response !== 'granted') {
        console.warn('[Compass] iOS motion permission denied.');
        uiModule.setDot(dom.compassDot, 'error');
        uiModule.showCompassBanner();
        return false;
      }

      console.log('[Compass] iOS motion permission granted.');
    }
    // Android / desktop: no requestPermission needed; fall through.

    this._listen();
    return true;
  },

  _listen() {
    let lastUpdate  = 0;
    let hasAbsolute = false;

    // EMA smoothing state — unit-vector form handles 0/360 wrap-around for heading
    let smoothSinH = null, smoothCosH = null; // heading EMA (circular)
    let smoothTilt = null;                     // tilt EMA (linear)
    const ALPHA_H = 0.25;
    const ALPHA_T = 0.25;

    // Jump-rejection gate
    const JUMP_LIMIT  = 60;  // degrees — tightened from 75 to catch near-zenith drift
    const RESET_COUNT = 8;   // consecutive out-of-gate readings before accepting a real rotation
    let gateRejects   = 0;

    // Zenith lock with hysteresis: enter at > 60°, exit at < 50°.
    // Prevents the guard from flickering on/off when tilt oscillates near the threshold.
    let isZenithLocked = false;

    state.compassHandler = (event) => {
      if (event.absolute === true) hasAbsolute = true;
      if (!event.absolute && hasAbsolute) return;

      // Throttle to 20 Hz — halved from 100ms to reduce perceived lag during movement
      const now = Date.now();
      if (now - lastUpdate < 50) return;
      lastUpdate = now;

      let heading = null;
      if (typeof event.webkitCompassHeading === 'number') {
        // iOS accuracy gate: skip readings the sensor flags as unreliable (> ±45°)
        const acc = event.webkitCompassAccuracy;
        if (typeof acc === 'number' && acc > 45) return;
        heading = event.webkitCompassHeading;
      } else if (typeof event.alpha === 'number') {
        heading = (360 - event.alpha + 360) % 360;
      }
      if (heading === null || !isFinite(heading)) return;

      // ── Tilt (computed first — needed for zenith guard below) ─────
      // event.beta: 0° = flat, 90° = upright portrait, >90° = tilted back.
      // Camera elevation = beta − 90 so that upright (beta=90) → camAlt=0°.
      if (typeof event.beta === 'number') {
        const rawTilt = event.beta - 90;
        smoothTilt = smoothTilt === null
          ? rawTilt
          : ALPHA_T * rawTilt + (1 - ALPHA_T) * smoothTilt;
        state.tilt = smoothTilt;
      }

      // ── Zenith / nadir guard (with hysteresis) ───────────────────
      // When the camera aims near zenith/nadir, webkitCompassHeading spins
      // erratically (gimbal lock). Freeze heading at its last good value.
      // Hysteresis: lock at > 60°, unlock at < 50° — prevents the guard from
      // toggling on/off when the smoothed tilt oscillates near the threshold.
      const camAlt = state.tilt ?? 0;
      const absAlt = Math.abs(camAlt);
      if (!isZenithLocked && absAlt > 60) {
        isZenithLocked = true;
        gateRejects = 0; // reset gate so it starts clean when we re-enter normal range
      } else if (isZenithLocked && absAlt < 50) {
        isZenithLocked = false;
      }
      if (isZenithLocked) {
        uiModule.setDot(dom.compassDot, 'active');
        if (state.heading !== null) {
          uiModule.updateCompass(state.heading);
          if (state.sun.azimuth  !== null) uiModule.updateSunArrow(state.sun.azimuth,  state.heading);
          if (state.moon.azimuth !== null) uiModule.updateMoonArrow(state.moon.azimuth, state.heading);
        }
        return;
      }

      // ── Jump-rejection gate ───────────────────────────────────────
      // Discard readings that spike more than JUMP_LIMIT° from the current
      // smoothed heading. After RESET_COUNT consecutive out-of-gate readings
      // (= user has genuinely rotated that far), reset and accept.
      if (smoothSinH !== null) {
        const curDeg = (Math.atan2(smoothSinH, smoothCosH) * 180 / Math.PI + 360) % 360;
        let diff = heading - curDeg;
        if (diff >  180) diff -= 360;
        if (diff < -180) diff += 360;
        if (Math.abs(diff) > JUMP_LIMIT) {
          if (++gateRejects < RESET_COUNT) return; // glitch — discard
          // Enough consecutive out-of-gate readings → genuine rotation; reset EMA
          const rad0 = heading * Math.PI / 180;
          smoothSinH = Math.sin(rad0);
          smoothCosH = Math.cos(rad0);
          gateRejects = 0;
        } else {
          gateRejects = 0;
        }
      }

      // ── Circular EMA for heading (avoids 359°→1° jump artefact) ──
      const rad = heading * Math.PI / 180;
      if (smoothSinH === null) {
        smoothSinH = Math.sin(rad);
        smoothCosH = Math.cos(rad);
      } else {
        smoothSinH = ALPHA_H * Math.sin(rad) + (1 - ALPHA_H) * smoothSinH;
        smoothCosH = ALPHA_H * Math.cos(rad) + (1 - ALPHA_H) * smoothCosH;
      }
      const smoothedHeading = (Math.atan2(smoothSinH, smoothCosH) * 180 / Math.PI + 360) % 360;
      state.heading = smoothedHeading;

      uiModule.setDot(dom.compassDot, 'active');
      uiModule.updateCompass(smoothedHeading);

      // Keep both AR arrows aligned to the new heading
      if (state.sun.azimuth  !== null) uiModule.updateSunArrow(state.sun.azimuth,  smoothedHeading);
      if (state.moon.azimuth !== null) uiModule.updateMoonArrow(state.moon.azimuth, smoothedHeading);
    };

    // Register on both event types; the flag above handles deduplication.
    window.addEventListener('deviceorientationabsolute', state.compassHandler, true);
    window.addEventListener('deviceorientation',         state.compassHandler, true);

    console.log('[Compass] Listening for orientation events.');
  },

  stop() {
    if (state.compassHandler) {
      window.removeEventListener('deviceorientationabsolute', state.compassHandler, true);
      window.removeEventListener('deviceorientation',         state.compassHandler, true);
      state.compassHandler = null;
    }
    state.heading = null;
    uiModule.setDot(dom.compassDot, 'idle');
  },
};


// ================================================================
// SUN MODULE
// Uses SunCalc (loaded in index.html) to compute real-time sun
// azimuth and elevation from the current GPS coordinates.
//
// SunCalc.getPosition(date, lat, lng) returns:
//   .altitude  Radians above horizon (+) or below horizon (−)
//   .azimuth   Radians from SOUTH, clockwise
//              → convert to 0–360° from North:
//              (az_rad * 180/π + 180 + 360) % 360
// ================================================================
const sunModule = {

  // Throttle: the sun moves ~0.25°/min — recalculating every 10 s
  // is more than sufficient and avoids redundant JS execution.
  _INTERVAL_MS:  10_000,
  _lastCalcTime: 0,

  update(lat, lng) {
    const now = Date.now();
    if (now - this._lastCalcTime < this._INTERVAL_MS) return;
    this._lastCalcTime = now;

    if (typeof SunCalc === 'undefined') {
      console.warn('[Sun] SunCalc not found on window — check the CDN script tag in index.html.');
      uiModule.updateSun(null, null);
      return;
    }

    const pos          = SunCalc.getPosition(new Date(), lat, lng);
    const azimuthDeg   = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360;
    const elevationDeg = pos.altitude  * 180 / Math.PI;

    state.sun.azimuth   = azimuthDeg;
    state.sun.elevation = elevationDeg;

    uiModule.updateSun(azimuthDeg, elevationDeg);
    uiModule.updateSunArrow(azimuthDeg, state.heading);
  },
};


// ================================================================
// GOLDEN HOUR MODULE
// Uses SunCalc.getTimes() to build the full day light schedule.
// Called every time GPS updates; internally throttled to 1 min
// (times only shift meaningfully when the date changes or you move
// far enough to affect civil twilight — throttle keeps it cheap).
// ================================================================
const goldenHourModule = {

  _INTERVAL_MS: 60_000,
  _lastUpdate:  0,

  update(lat, lng) {
    const now = Date.now();
    if (now - this._lastUpdate < this._INTERVAL_MS) return;
    this._lastUpdate = now;

    if (typeof SunCalc === 'undefined') return;

    const times = SunCalc.getTimes(new Date(), lat, lng);
    uiModule.updateLightSchedule(times);
  },
};


// ================================================================
// MOON PHASE HELPERS
// ================================================================
function moonPhaseEmoji(phase) {
  // phase 0–1: 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter
  if (phase < 0.0625) return '🌑';
  if (phase < 0.1875) return '🌒';
  if (phase < 0.3125) return '🌓';
  if (phase < 0.4375) return '🌔';
  if (phase < 0.5625) return '🌕';
  if (phase < 0.6875) return '🌖';
  if (phase < 0.8125) return '🌗';
  if (phase < 0.9375) return '🌘';
  return '🌑';
}

function moonPhaseName(phase) {
  if (phase < 0.0625) return 'New Moon';
  if (phase < 0.1875) return 'Waxing Crescent';
  if (phase < 0.3125) return 'First Quarter';
  if (phase < 0.4375) return 'Waxing Gibbous';
  if (phase < 0.5625) return 'Full Moon';
  if (phase < 0.6875) return 'Waning Gibbous';
  if (phase < 0.8125) return 'Last Quarter';
  if (phase < 0.9375) return 'Waning Crescent';
  return 'New Moon';
}

function fmtTime(date) {
  if (!date || !(date instanceof Date) || isNaN(date)) return '--:--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}


// ================================================================
// MOON MODULE
// Uses SunCalc (already loaded) for position, illumination, and
// rise/set times. Throttled to 30 s — the moon moves ~0.5°/min.
// ================================================================
const moonModule = {

  _INTERVAL_MS: 30_000,
  _lastUpdate:  0,

  update(lat, lng) {
    const now = Date.now();
    if (now - this._lastUpdate < this._INTERVAL_MS) return;
    this._lastUpdate = now;

    if (typeof SunCalc === 'undefined') return;

    const date  = new Date();

    // Position
    const pos          = SunCalc.getMoonPosition(date, lat, lng);
    const azimuthDeg   = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360;
    const elevationDeg = pos.altitude * 180 / Math.PI;

    // Illumination + phase
    const illum  = SunCalc.getMoonIllumination(date);

    // Rise / set (SunCalc searches within the current day)
    const times  = SunCalc.getMoonTimes(date, lat, lng);

    state.moon = {
      azimuth:      azimuthDeg,
      elevation:    elevationDeg,
      illumination: illum.fraction,
      phase:        illum.phase,
      phaseName:    moonPhaseName(illum.phase),
      phaseEmoji:   moonPhaseEmoji(illum.phase),
      rise:         times.rise  || null,
      set:          times.set   || null,
    };

    uiModule.updateMoon(state.moon);

    // Rotate the AR arrow now that we have position + heading
    if (state.heading !== null) {
      uiModule.updateMoonArrow(azimuthDeg, state.heading);
    }
  },
};


// ================================================================
// PLANETS MODULE
// Uses astronomy-engine to find visible planets above the horizon.
// Shows Mercury, Venus, Mars, Jupiter, Saturn.
// Throttled to 60 s — planet positions are slow-moving.
// ================================================================
const planetsModule = {

  _INTERVAL_MS: 60_000,
  _lastUpdate:  0,

  _BODIES: [
    { name: 'Mercury', icon: '☿', color: 'text-slate-300' },
    { name: 'Venus',   icon: '♀', color: 'text-yellow-200' },
    { name: 'Mars',    icon: '♂', color: 'text-red-400'   },
    { name: 'Jupiter', icon: '♃', color: 'text-orange-200' },
    { name: 'Saturn',  icon: '♄', color: 'text-amber-200' },
  ],

  update(lat, lng) {
    const now = Date.now();
    if (now - this._lastUpdate < this._INTERVAL_MS) return;
    this._lastUpdate = now;

    if (typeof Astronomy === 'undefined') return;

    const date     = new Date();
    const observer = new Astronomy.Observer(lat, lng, 0);

    const visible = [];

    for (const body of this._BODIES) {
      try {
        // Equatorial coordinates (true of date, with aberration)
        const equ = Astronomy.Equator(Astronomy.Body[body.name], date, observer, true, true);
        // Convert to local horizontal coordinates
        const hor = Astronomy.Horizon(date, observer, equ.ra, equ.dec, 'normal');

        if (hor.altitude > 0) {
          visible.push({
            name:      body.name,
            icon:      body.icon,
            color:     body.color,
            azimuth:   hor.azimuth,
            elevation: hor.altitude,
          });
        }
      } catch {
        // astronomy-engine throws if a body calculation fails (rare edge case)
      }
    }

    // Sort by elevation descending (highest in sky first)
    visible.sort((a, b) => b.elevation - a.elevation);

    state.planets = visible;
    uiModule.updatePlanets(visible);
  },
};


// ================================================================
// SKY CHART MODULE
// Renders a Stellarium-like interactive sky dome on <canvas id="sky-canvas">.
//
// Coordinate pipeline:
//   GPS + time → Local Sidereal Time → RA/Dec → Alt/Az
//   Alt/Az + compass heading → canvas x,y  (heading faces canvas top)
//
// Layers: space gradient → altitude rings → constellation lines
//         → stars (coloured, sized, glow) → labels → moon → planets
//         → horizon ring → cardinal labels
// ================================================================
const skyChartModule = {

  _canvas:      null,
  _ctx:         null,
  _plotData:    null,
  _lastCompute: 0,
  _COMPUTE_MS:  5_000,

  _SPECTRAL: {
    O: '#9bb0ff', B: '#aabfff', A: '#ffffff',
    F: '#fff4ea', G: '#ffd27f', K: '#ffb347', M: '#ff6b6b',
  },

  init() {
    this._canvas = document.getElementById('sky-canvas');
    if (!this._canvas) return;
    this._ctx = this._canvas.getContext('2d');
    const tick = () => { this._draw(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  },

  update(lat, lng) {
    const now = Date.now();
    if (now - this._lastCompute < this._COMPUTE_MS) return;
    this._lastCompute = now;
    this._recompute(lat, lng);
  },

  refresh() {
    this._lastCompute = 0;
    if (state.coords) this._recompute(state.coords.latitude, state.coords.longitude);
  },

  _recompute(lat, lng) {
    if (typeof STAR_CATALOG === 'undefined' || typeof CONST_LINES === 'undefined') return;
    const date = new Date();
    const lst  = this._getLST(lng, date);

    const stars = STAR_CATALOG.map(([ra, dec, mag, spec, name]) => ({
      ...this._raDecToAltAz(ra, dec, lat, lst), mag, spec, name,
    }));

    const constLines = CONST_LINES.map(([, segs]) =>
      segs.map(pts => pts.map(([ra, dec]) => this._raDecToAltAz(ra, dec, lat, lst)))
    );

    const moon = (state.moon.azimuth !== null) ? {
      alt: state.moon.elevation, az: state.moon.azimuth,
      emoji: state.moon.phaseEmoji ?? '🌙',
    } : null;

    const planets = state.planets.map(p => ({
      alt: p.elevation, az: p.azimuth, icon: p.icon, name: p.name,
    }));

    // Today's sun path arc (15-min intervals, full 24 h)
    const sunPath = [];
    if (typeof SunCalc !== 'undefined') {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (let m = 0; m < 1440; m += 15) {
        const t   = new Date(today.getTime() + m * 60_000);
        const pos = SunCalc.getPosition(t, lat, lng);
        sunPath.push({
          alt: pos.altitude  * 180 / Math.PI,
          az:  (pos.azimuth  * 180 / Math.PI + 180 + 360) % 360,
          hour: t.getHours(), min: t.getMinutes(),
        });
      }
    }

    this._plotData = { stars, constLines, moon, planets, sunPath };
  },

  _getLST(lng_deg, date) {
    const JD   = date.getTime() / 86400000 + 2440587.5;
    const GMST = (280.46061837 + 360.98564736629 * (JD - 2451545.0)) % 360;
    return ((GMST + lng_deg) % 360 + 360) % 360;
  },

  _raDecToAltAz(ra_h, dec_deg, lat_deg, lst_deg) {
    const D   = Math.PI / 180;
    const ha  = ((lst_deg - ra_h * 15) % 360 + 360) % 360 * D;
    const dec = dec_deg * D;
    const lat = lat_deg * D;

    const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
    const alt    = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / D;

    const cosAz = (Math.sin(dec) - Math.sin(alt * D) * Math.sin(lat)) /
                  (Math.cos(alt * D) * Math.cos(lat));
    const az0   = Math.acos(Math.max(-1, Math.min(1, cosAz))) / D;
    const az    = Math.sin(ha) > 0 ? 360 - az0 : az0;

    return { alt, az };
  },

  _proj(alt, az, cx, cy, r, heading) {
    const a = ((az - heading) % 360 + 360) % 360 * Math.PI / 180;
    const d = (90 - alt) / 90 * r;
    return { x: cx - d * Math.sin(a), y: cy - d * Math.cos(a) };
  },

  _magR(mag) { return Math.max(1.0, 9.64 - 1.81 * mag); },

  _draw() {
    const canvas = this._canvas;
    const ctx    = this._ctx;
    if (!canvas || !ctx) return;

    const dpr     = window.devicePixelRatio || 1;
    const cssSize = canvas.offsetWidth;
    if (cssSize < 4) return;

    const pxSize = Math.round(cssSize * dpr);
    if (canvas.width !== pxSize) {
      canvas.width  = pxSize;
      canvas.height = pxSize;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    const cx = cssSize / 2;
    const cy = cssSize / 2;
    const r  = cx - 6;
    const h  = state.heading ?? 0;

    // Deep space background
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    bg.addColorStop(0,   '#06111f');
    bg.addColorStop(0.7, '#030b16');
    bg.addColorStop(1,   '#020609');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = bg;
    ctx.fill();

    // Clip to dome circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();

    if (!this._plotData) {
      ctx.fillStyle    = '#475569';
      ctx.font         = '11px monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waiting for GPS…', cx, cy);
      ctx.restore();
      return;
    }

    const { stars, constLines, moon, planets } = this._plotData;

    // Altitude rings at 30° and 60°
    ctx.strokeStyle = 'rgba(51,65,85,0.25)';
    ctx.lineWidth   = 0.5;
    [30, 60].forEach(alt => {
      ctx.beginPath();
      ctx.arc(cx, cy, (90 - alt) / 90 * r, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Constellation lines
    ctx.strokeStyle = 'rgba(99,102,241,0.3)';
    ctx.lineWidth   = 0.7;
    constLines.forEach(segs => {
      segs.forEach(pts => {
        if (!pts.some(p => p.alt > -8)) return;
        ctx.beginPath();
        let pen = false;
        pts.forEach(p => {
          if (p.alt < -20) { pen = false; return; }
          const { x, y } = this._proj(p.alt, p.az, cx, cy, r, h);
          if (pen) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); pen = true; }
        });
        ctx.stroke();
      });
    });

    // Stars
    const labeled = new Set();
    stars.forEach(({ alt, az, mag, spec, name }) => {
      if (alt < -3) return;
      const { x, y } = this._proj(alt, az, cx, cy, r, h);
      const rad   = this._magR(mag);
      const color = this._SPECTRAL[spec] ?? '#ffffff';

      if (mag < 2.0) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad * 4);
        g.addColorStop(0, color + 'aa');
        g.addColorStop(1, color + '00');
        ctx.beginPath();
        ctx.arc(x, y, rad * 4, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      if (name && mag < 1.8 && alt > 5 && !labeled.has(name)) {
        labeled.add(name);
        ctx.fillStyle    = 'rgba(148,163,184,0.7)';
        ctx.font         = '9px monospace';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, x + rad + 2, y);
      }
    });

    // Sun path arc for today
    const { sunPath } = this._plotData;
    if (sunPath && sunPath.length > 0) {
      ctx.strokeStyle = 'rgba(251,191,36,0.55)';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      let sunPen = false;
      sunPath.forEach(p => {
        if (p.alt < -3) { sunPen = false; return; }
        const { x, y } = this._proj(p.alt, p.az, cx, cy, r, h);
        if (sunPen) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); sunPen = true; }
      });
      ctx.stroke();

      // Hour labels at whole-hour positions above horizon
      ctx.fillStyle    = 'rgba(251,191,36,0.65)';
      ctx.font         = '8px monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'bottom';
      sunPath.filter(p => p.min === 0 && p.alt > 2).forEach(p => {
        const { x, y } = this._proj(p.alt, p.az, cx, cy, r, h);
        ctx.fillText(String(p.hour), x + 2, y - 1);
      });
    }

    // Current sun position on dome (drawn over arc)
    if (state.sun.azimuth !== null && state.sun.elevation > -3) {
      const { x, y } = this._proj(state.sun.elevation, state.sun.azimuth, cx, cy, r, h);
      ctx.font         = '16px serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#ffffff';
      ctx.fillText('☀', x, y);
    }

    // Moon
    if (moon && moon.alt > -3) {
      const { x, y } = this._proj(moon.alt, moon.az, cx, cy, r, h);
      ctx.font         = '18px serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#ffffff';
      ctx.fillText(moon.emoji, x, y);
    }

    // Planets
    planets.forEach(p => {
      if (p.alt < -3) return;
      const { x, y } = this._proj(p.alt, p.az, cx, cy, r, h);
      ctx.font         = '13px serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#ffffff';
      ctx.fillText(p.icon, x, y);
      ctx.fillStyle    = 'rgba(148,163,184,0.65)';
      ctx.font         = '8px monospace';
      ctx.textBaseline = 'top';
      ctx.fillText(p.name, x, y + 9);
    });

    // Remove clip, draw horizon ring and cardinal labels outside it
    ctx.restore();
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(71,85,105,0.55)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ['N', 'E', 'S', 'W'].forEach((card, i) => {
      const a  = ((i * 90 - h) % 360 + 360) % 360 * Math.PI / 180;
      const lx = cx - (r + 12) * Math.sin(a);
      const ly = cy - (r + 12) * Math.cos(a);
      ctx.font      = 'bold 9px monospace';
      ctx.fillStyle = card === 'N' ? 'rgba(251,191,36,0.9)' : 'rgba(148,163,184,0.65)';
      ctx.fillText(card, lx, ly);
    });

    // Tick mark at top = device heading direction
    ctx.strokeStyle = 'rgba(251,191,36,0.5)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r + 1);
    ctx.lineTo(cx, cy - r + 9);
    ctx.stroke();

    ctx.restore();
  },
};


// ================================================================
// AR OVERLAY MODULE
// Projects sun/moon paths + azimuth/elevation grid onto camera feed.
//
// Shows today + 3 seasonal sun paths simultaneously; supports a
// user-selected custom date. Equirectangular projection:
//   x = W/2 + (dAz / FOV_H) * W
//   y = H/2 − (dAlt / FOV_V) * H
// ================================================================
const arOverlayModule = {

  _canvas:      null,
  _ctx:         null,
  _sunPaths:          {},   // { key: [{alt, az, hour, min}] }
  _moonPath:          null, // today's moon path [{alt, az, hour, min}]
  _monthlyMoonPaths:  {},   // { 'moon-jan': [...], ... } bi-monthly snapshots
  _lastCompute: 0,
  _COMPUTE_MS:  300_000,

  _MOON_PATHS: [
    { key: 'moon-jan', label: 'Jan', color: 'rgba(226,232,240,0.85)', month: 0,  day: 15 },
    { key: 'moon-mar', label: 'Mar', color: 'rgba(186,230,253,0.85)', month: 2,  day: 15 },
    { key: 'moon-may', label: 'May', color: 'rgba(110,231,183,0.85)', month: 4,  day: 15 },
    { key: 'moon-jul', label: 'Jul', color: 'rgba(216,180,254,0.85)', month: 6,  day: 15 },
    { key: 'moon-sep', label: 'Sep', color: 'rgba(253,186,116,0.85)', month: 8,  day: 15 },
    { key: 'moon-nov', label: 'Nov', color: 'rgba(165,180,252,0.85)', month: 10, day: 15 },
  ],
  _activeMoonPaths: new Set(), // off by default — user toggles on

  // ── Field of View (degrees) ─────────────────────────────────────
  // iPhone main camera (26 mm eq.) sensor is landscape-oriented.
  // In portrait mode the narrow axis becomes the screen width:
  //   FOV_H ≈ 56°  (left–right in portrait  = landscape height FOV)
  //   FOV_V ≈ 74°  (up–down   in portrait  = landscape width  FOV)
  // Tune these if sun/moon drift off-centre vs. real scene.
  _FOV_H: 56,
  _FOV_V: 74,

  // Precomputed tan(FOV/2) for perspective projection (set in init)
  _tanHH: 0,
  _tanHV: 0,

  _PATHS: [
    { key: 'today', label: 'Today',  color: 'rgba(251,191,36,0.9)',  month: null, day: null },
    { key: 'jun21', label: 'Jun 21', color: 'rgba(239,68,68,0.85)',  month: 5,    day: 21  },
    { key: 'mar20', label: 'Mar 20', color: 'rgba(74,222,128,0.85)', month: 2,    day: 20  },
    { key: 'dec21', label: 'Dec 21', color: 'rgba(147,197,253,0.85)',month: 11,   day: 21  },
  ],
  _activePaths: new Set(['today', 'jun21', 'mar20', 'dec21']),
  _showGrid:    true,

  init() {
    this._canvas = document.getElementById('ar-canvas');
    if (!this._canvas) return;
    this._ctx = this._canvas.getContext('2d');
    this._tanHH = Math.tan((this._FOV_H / 2) * Math.PI / 180);
    this._tanHV = Math.tan((this._FOV_V / 2) * Math.PI / 180);
    const tick = () => { this._draw(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  },

  update(lat, lng) {
    const now = Date.now();
    if (now - this._lastCompute < this._COMPUTE_MS) return;
    this._lastCompute = now;
    this._recompute(lat, lng);
  },

  refresh() {
    this._lastCompute = 0;
    if (state.coords) this._recompute(state.coords.latitude, state.coords.longitude);
  },

  togglePath(key) {
    if (this._activePaths.has(key)) this._activePaths.delete(key);
    else                            this._activePaths.add(key);
    uiModule.updateArPathButtons(this._activePaths);
  },

  setCustomDate(dateStr) {
    if (!dateStr || !state.coords) return;
    const [y, mo, d] = dateStr.split('-').map(Number);
    this._computePath(
      state.coords.latitude, state.coords.longitude,
      new Date(y, mo - 1, d, 0, 0, 0), 'custom'
    );
    if (!this._PATHS.find(p => p.key === 'custom')) {
      this._PATHS.push({ key: 'custom', label: dateStr.slice(5), color: 'rgba(251,146,60,0.9)' });
    }
    this._activePaths.add('custom');
    uiModule.updateArPathButtons(this._activePaths);
  },

  _recompute(lat, lng) {
    if (typeof SunCalc === 'undefined') return;
    const year  = new Date().getFullYear();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const p of this._PATHS) {
      if (p.key === 'custom') continue;
      const base = (p.month !== null) ? new Date(year, p.month, p.day, 0, 0, 0) : today;
      this._computePath(lat, lng, base, p.key);
    }
    this._computeMoonPath(lat, lng, today, null);
    for (const mp of this._MOON_PATHS) {
      const base = new Date(year, mp.month, mp.day, 0, 0, 0);
      this._computeMoonPath(lat, lng, base, mp.key);
    }
  },

  // key=null → store as today's path (_moonPath); key=string → store in _monthlyMoonPaths
  _computeMoonPath(lat, lng, base, key) {
    const path = [];
    for (let m = 0; m < 1440; m += 10) {
      const t   = new Date(base.getTime() + m * 60_000);
      const pos = SunCalc.getMoonPosition(t, lat, lng);
      path.push({
        alt:  pos.altitude * 180 / Math.PI,
        az:   (pos.azimuth  * 180 / Math.PI + 180 + 360) % 360,
        hour: t.getHours(),
        min:  t.getMinutes(),
      });
    }
    if (key) { this._monthlyMoonPaths[key] = path; }
    else      { this._moonPath = path; }
  },

  toggleMoonPath(key) {
    if (this._activeMoonPaths.has(key)) this._activeMoonPaths.delete(key);
    else                                this._activeMoonPaths.add(key);
    uiModule.updateMoonPathButtons(this._activeMoonPaths);
  },

  _computePath(lat, lng, base, key) {
    const path = [];
    for (let m = 0; m < 1440; m += 10) {
      const t   = new Date(base.getTime() + m * 60_000);
      const pos = SunCalc.getPosition(t, lat, lng);
      path.push({
        alt:  pos.altitude * 180 / Math.PI,
        az:   (pos.azimuth * 180 / Math.PI + 180 + 360) % 360,
        hour: t.getHours(),
        min:  t.getMinutes(),
      });
    }
    this._sunPaths[key] = path;
  },

  _proj(alt, az, camAlt, camAz, W, H) {
    // ── Step 1: angular delta from camera centre ──────────────────
    // Normalize azimuth diff to −180…+180 so crossing North (359→1°) works.
    let dAz = az - camAz;
    if (dAz >  180) dAz -= 360;
    if (dAz < -180) dAz += 360;

    // Camera elevation offset: positive = sun above camera aim-point.
    // devicePitch (beta) is converted to camAlt as (beta − 90) upstream,
    // so camAlt=0 when phone is upright and the sun is at the horizon.
    const dAlt = alt - camAlt;

    // ── Step 2: perspective (tan) projection ─────────────────────
    // tan(dAz) / tan(FOV_H/2) maps angle → normalised −1…+1 range.
    // Multiply by half-width/height to get canvas pixels.
    // Canvas Y=0 is top-of-screen, so we subtract to make elevation go UP.
    const x = W / 2 + (W / 2) * Math.tan(dAz  * Math.PI / 180) / this._tanHH;
    const y = H / 2 - (H / 2) * Math.tan(dAlt * Math.PI / 180) / this._tanHV;

    // ── Step 3: inFrame test ──────────────────────────────────────
    const inFrame = Math.abs(dAz) < this._FOV_H * 0.48
                 && Math.abs(dAlt) < this._FOV_V * 0.48;

    return { x, y, inFrame, dAz };
  },

  _pill(ctx, x, y, text, color) {
    ctx.font = 'bold 10px monospace';
    const tw = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    const rx = x - tw / 2, ry = y - 16;
    if (ctx.roundRect) { ctx.roundRect(rx, ry, tw, 14, 3); } else { ctx.rect(rx, ry, tw, 14); }
    ctx.fill();
    ctx.fillStyle    = color;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, ry + 7);
  },

  _draw() {
    const canvas = this._canvas;
    const ctx    = this._ctx;
    if (!canvas || !ctx || !state.permissionsGranted) return;

    const W = window.innerWidth;
    const H = window.innerHeight;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width  = W;
      canvas.height = H;
    }
    ctx.clearRect(0, 0, W, H);
    if (!state.coords) return;

    // When compass is unavailable, assume North (0°) so the AR view
    // still renders — a banner at the top explains the assumption.
    const camAz  = state.heading ?? 0;
    const camAlt = state.tilt    ?? 0;

    // ── Azimuth / elevation grid ──────────────────────────────
    if (this._showGrid) {
      ctx.save();
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 0.75;

      // Horizontal elevation lines (perspective-correct y positions)
      for (let a = -15; a <= 75; a += 15) {
        const y = H / 2 - (H / 2) * Math.tan((a - camAlt) * Math.PI / 180) / this._tanHV;
        if (y < -10 || y > H + 10) continue;
        ctx.strokeStyle = a === 0 ? 'rgba(99,102,241,0.5)' : 'rgba(59,130,246,0.22)';
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        if (y > 12 && y < H - 4) {
          ctx.setLineDash([]);
          ctx.fillStyle    = 'rgba(147,197,253,0.6)';
          ctx.font         = '9px monospace';
          ctx.textAlign    = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(`${a}°`, 6, y - 1);
          ctx.setLineDash([4, 6]);
        }
      }

      // Vertical azimuth lines every 30° (perspective-correct x positions)
      for (let az = 0; az < 360; az += 30) {
        let dAz = az - camAz;
        if (dAz >  180) dAz -= 360;
        if (dAz < -180) dAz += 360;
        if (Math.abs(dAz) >= this._FOV_H / 2) continue;
        const x = W / 2 + (W / 2) * Math.tan(dAz * Math.PI / 180) / this._tanHH;
        ctx.strokeStyle = 'rgba(59,130,246,0.22)';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle    = 'rgba(147,197,253,0.6)';
        ctx.font         = '9px monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(`${az}° ${this._toCardinal(az)}`, x, 4);
        ctx.setLineDash([4, 6]);
      }

      ctx.setLineDash([]);
      ctx.restore();
    }

    // ── Sun paths (today + seasonal + custom) ─────────────────
    for (const p of this._PATHS) {
      if (!this._activePaths.has(p.key)) continue;
      const path = this._sunPaths[p.key];
      if (!path) continue;

      ctx.save();
      ctx.strokeStyle = p.color;
      ctx.lineWidth   = 2;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      let pen = false;
      path.forEach(pt => {
        if (pt.alt <= 0) { pen = false; return; }
        const { x, y, inFrame } = this._proj(pt.alt, pt.az, camAlt, camAz, W, H);
        if (inFrame) {
          if (pen) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); pen = true; }
        } else { pen = false; }
      });
      ctx.stroke();

      // Hour dots + labels — every 3 h to avoid crowding (6am, 9am, 12pm…)
      path.filter(pt => pt.min === 0 && pt.hour % 3 === 0 && pt.alt > 0).forEach(pt => {
        const { x, y, inFrame } = this._proj(pt.alt, pt.az, camAlt, camAz, W, H);
        if (!inFrame) return;
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = p.color; ctx.fill();
        const hLabel = pt.hour < 12 ? `${pt.hour}am`
                     : pt.hour === 12 ? '12pm' : `${pt.hour - 12}pm`;
        const suffix = (p.key !== 'today') ? ` ${p.label}` : '';
        this._pill(ctx, x, y - 2, hLabel + suffix, p.color);
      });

      ctx.restore();
    }

    // ── Current sun (disc + rays + crosshair + info) ─────────
    // Beyond ±90° the tan() projection wraps and mirrors the sun onto the
    // opposite side of the screen, so skip drawing once we're facing away.
    if (state.sun.azimuth !== null && state.sun.elevation !== null) {
      const alt = state.sun.elevation;
      const az  = state.sun.azimuth;
      const { x, y, dAz } = this._proj(alt, az, camAlt, camAz, W, H);

      if (Math.abs(dAz) <= 90) {

      ctx.save();

      // Outer atmospheric glow (above horizon only)
      if (alt > 0) {
        const atmo = ctx.createRadialGradient(x, y, 10, x, y, 56);
        atmo.addColorStop(0, 'rgba(251,191,36,0.35)');
        atmo.addColorStop(0.5, 'rgba(251,130,0,0.12)');
        atmo.addColorStop(1, 'rgba(251,191,36,0)');
        ctx.beginPath(); ctx.arc(x, y, 56, 0, Math.PI * 2);
        ctx.fillStyle = atmo; ctx.fill();
      }

      // 8 sun rays
      const RAY_INNER = 17, RAY_OUTER = 28;
      ctx.strokeStyle = 'rgba(253,224,71,0.85)';
      ctx.lineWidth   = 2;
      ctx.lineCap     = 'round';
      for (let i = 0; i < 8; i++) {
        const a = (i * 45) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(x + RAY_INNER * Math.cos(a), y + RAY_INNER * Math.sin(a));
        ctx.lineTo(x + RAY_OUTER * Math.cos(a), y + RAY_OUTER * Math.sin(a));
        ctx.stroke();
      }

      // Sun disc — yellow circle with inner highlight
      const DISC_R = 13;
      const disc = ctx.createRadialGradient(x - 3, y - 3, 1, x, y, DISC_R);
      disc.addColorStop(0, '#fffde7');   // near-white highlight
      disc.addColorStop(0.4, '#fde047'); // bright yellow
      disc.addColorStop(1,   '#f59e0b'); // amber edge
      ctx.beginPath(); ctx.arc(x, y, DISC_R, 0, Math.PI * 2);
      ctx.fillStyle = disc; ctx.fill();

      // Thin edge stroke so the disc reads clearly over bright sky
      ctx.strokeStyle = 'rgba(180,100,0,0.45)';
      ctx.lineWidth   = 1;
      ctx.stroke();

      // Crosshair ring
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 24, 0, Math.PI * 2); ctx.stroke();
      [0, 90, 180, 270].forEach(a => {
        const r = a * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(x + 24 * Math.sin(r), y - 24 * Math.cos(r));
        ctx.lineTo(x + 33 * Math.sin(r), y - 33 * Math.cos(r));
        ctx.stroke();
      });

      ctx.restore();

      // Info pill
      ctx.font = 'bold 11px monospace';
      const altStr = alt >= 0 ? `+${alt.toFixed(0)}` : alt.toFixed(0);
      const info   = `Ele: ${altStr}°  Az: ${az.toFixed(0)}° (${this._toCardinal(az)})`;
      const iw     = ctx.measureText(info).width + 14;
      const ix = x - iw / 2, iy = y + 38;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(ix, iy, iw, 18, 4); } else { ctx.rect(ix, iy, iw, 18); }
      ctx.fill();
      ctx.fillStyle = 'rgba(251,191,36,0.95)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(info, x, iy + 9);
      }
    }

    // ── Monthly moon paths ────────────────────────────────────
    for (const mp of this._MOON_PATHS) {
      if (!this._activeMoonPaths.has(mp.key)) continue;
      const mpath = this._monthlyMoonPaths[mp.key];
      if (!mpath) continue;
      ctx.save();
      ctx.strokeStyle = mp.color;
      ctx.lineWidth   = 1.5;
      ctx.lineCap     = 'round';
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      let mpen = false;
      mpath.forEach(pt => {
        if (pt.alt <= 0) { mpen = false; return; }
        const { x, y, inFrame } = this._proj(pt.alt, pt.az, camAlt, camAz, W, H);
        if (inFrame) {
          if (mpen) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); mpen = true; }
        } else { mpen = false; }
      });
      ctx.stroke();
      ctx.setLineDash([]);
      // Label at the point with the highest visible altitude in-frame
      let bestPt = null, bestAlt = -Infinity;
      mpath.forEach(pt => {
        if (pt.alt <= 0) return;
        const { inFrame } = this._proj(pt.alt, pt.az, camAlt, camAz, W, H);
        if (inFrame && pt.alt > bestAlt) { bestAlt = pt.alt; bestPt = pt; }
      });
      if (bestPt) {
        const { x, y } = this._proj(bestPt.alt, bestPt.az, camAlt, camAz, W, H);
        this._pill(ctx, x, y - 14, mp.label, mp.color);
      }
      ctx.restore();
    }

    // ── Moon path arc (today) ─────────────────────────────────
    if (this._moonPath) {
      ctx.save();
      ctx.strokeStyle = 'rgba(186,230,253,0.7)'; // pale sky-blue
      ctx.lineWidth   = 1.5;
      ctx.lineCap     = 'round';
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      let moonPen = false;
      this._moonPath.forEach(pt => {
        if (pt.alt <= 0) { moonPen = false; return; }
        const { x, y, inFrame } = this._proj(pt.alt, pt.az, camAlt, camAz, W, H);
        if (inFrame) {
          if (moonPen) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); moonPen = true; }
        } else { moonPen = false; }
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // Hour labels every 2 h
      this._moonPath.filter(pt => pt.min === 0 && pt.hour % 2 === 0 && pt.alt > 0).forEach(pt => {
        const { x, y, inFrame } = this._proj(pt.alt, pt.az, camAlt, camAz, W, H);
        if (!inFrame) return;
        const lbl = pt.hour === 0 ? '12am' : pt.hour < 12 ? `${pt.hour}am`
                  : pt.hour === 12 ? '12pm' : `${pt.hour - 12}pm`;
        this._pill(ctx, x, y - 14, lbl, 'rgba(186,230,253,0.95)');
      });
      ctx.restore();
    }

    // ── Moon marker ───────────────────────────────────────────
    if (state.moon.azimuth !== null && state.moon.elevation > -5) {
      const { x, y, inFrame } = this._proj(
        state.moon.elevation, state.moon.azimuth, camAlt, camAz, W, H
      );
      if (inFrame) {
        ctx.font = '28px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff'; ctx.fillText(state.moon.phaseEmoji ?? '🌙', x, y);

        const altStr = state.moon.elevation >= 0
          ? `+${state.moon.elevation.toFixed(0)}`
          : state.moon.elevation.toFixed(0);
        const az  = state.moon.azimuth;
        const info = `Ele: ${altStr}°  Az: ${az.toFixed(0)}° (${this._toCardinal(az)})`;
        const iw  = (() => { ctx.font = 'bold 11px monospace'; return ctx.measureText(info).width + 14; })();
        const ix  = x - iw / 2, iy = y + 22;
        ctx.fillStyle = 'rgba(15,23,42,0.70)';
        ctx.beginPath();
        if (ctx.roundRect) { ctx.roundRect(ix, iy, iw, 18, 4); } else { ctx.rect(ix, iy, iw, 18); }
        ctx.fill();
        ctx.fillStyle = 'rgba(186,230,253,0.95)';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(info, x, iy + 9);
      }
    }

    // ── Compass-unavailable banner (drawn on top of AR) ───────
    if (state.heading === null) {
      this._drawNorthBanner(ctx, W, H);
    }
  },

  // Canvas-side no-op: the HTML #compass-banner handles the UI now.
  _drawNorthBanner() {},

  _toCardinal(deg) {
    const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                 'S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return pts[Math.round(deg / 22.5) % 16];
  },
};


// ================================================================
// UI MODULE
// All DOM mutations live here. Sensor modules call uiModule methods
// and never touch the DOM directly — keeps concerns separated.
// ================================================================
const uiModule = {

  // Set a header status dot to one of three visual states
  setDot(el, state) {
    el.className = 'w-2 h-2 rounded-full transition-colors duration-300 ';
    el.className += {
      active: 'bg-emerald-400 dot-pulse',
      error:  'bg-red-500',
      idle:   'bg-slate-700',
    }[state] ?? 'bg-slate-700';
  },

  // Show data card, hide permission gate
  showDataSection() {
    dom.permissionSection.classList.add('hidden');
    dom.dataSection.classList.remove('hidden');
    const sec  = document.getElementById('ar-path-section');
    const sec2 = document.getElementById('ar-moon-path-section');
    if (sec)  sec.classList.remove('hidden');
    if (sec2) sec2.classList.remove('hidden');
  },

  // Sync path-toggle button opacity to active set
  updateArPathButtons(activePaths) {
    ['today', 'jun21', 'mar20', 'dec21', 'custom'].forEach(key => {
      const btn = document.getElementById(`ar-btn-${key}`);
      if (btn) btn.style.opacity = activePaths.has(key) ? '1' : '0.3';
    });
  },

  updateMoonPathButtons(activePaths) {
    ['moon-jan', 'moon-mar', 'moon-may', 'moon-jul', 'moon-sep', 'moon-nov'].forEach(key => {
      const btn = document.getElementById(`ar-btn-${key}`);
      if (btn) btn.style.opacity = activePaths.has(key) ? '1' : '0.3';
    });
  },

  // GPS coordinates and accuracy
  updateGPS({ latitude, longitude, accuracy }) {
    dom.latDisplay.textContent      = latitude.toFixed(6);
    dom.lngDisplay.textContent      = longitude.toFixed(6);
    dom.accuracyDisplay.textContent = accuracy < 1000
      ? `±${Math.round(accuracy)} m`
      : `±${(accuracy / 1000).toFixed(1)} km`;
    this._refreshTimestamp();
  },

  // Compass heading (degrees and cardinal)
  updateCompass(heading) {
    const rounded = Math.round(heading);
    dom.headingDisplay.textContent  = `${rounded}°`;
    dom.compassDegrees.textContent  = `${rounded}°`;
    dom.compassCardinal.textContent = this._toCardinal(heading);
    // Hide the "enable compass" banner once heading is streaming
    dom.compassBanner?.classList.add('hidden');
  },

  showCompassBanner() {
    if (state.permissionsGranted) dom.compassBanner?.classList.remove('hidden');
  },

  // Sun azimuth and elevation (null = SunCalc not yet active)
  updateSun(azimuth, elevation) {
    if (azimuth !== null && elevation !== null) {
      dom.sunAzimuthDisplay.textContent   = `${azimuth.toFixed(1)}°`;
      dom.sunElevationDisplay.textContent = `${elevation.toFixed(1)}°`;
    } else {
      // Friendly placeholder until SunCalc is integrated
      dom.sunAzimuthDisplay.textContent   = '--- ° (add SunCalc)';
      dom.sunElevationDisplay.textContent = '--- ° (add SunCalc)';
    }
  },

  // Rotate the AR sun arrow to show where the sun is relative to the camera
  updateSunArrow(sunAzimuth, deviceHeading) {
    if (sunAzimuth === null || deviceHeading === null) return;

    // Relative angle: how many degrees to the right of camera-forward is the sun?
    const relative = (sunAzimuth - deviceHeading + 360) % 360;

    dom.sunArrow.style.transform         = `rotate(${relative}deg)`;
    dom.sunDirectionLabel.textContent    = `${this._toCardinal(sunAzimuth)}  ${sunAzimuth.toFixed(0)}°`;
    dom.sunDirectionWrap.style.opacity   = '1';
  },

  // Timestamp in the data card footer
  _refreshTimestamp() {
    const d = new Date();
    dom.timestampDisplay.textContent =
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
      '  ' +
      d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  },

  // Set permission button to a loading / idle appearance
  setPermBtnLoading(loading) {
    dom.btnPermissions.disabled  = loading;
    dom.permBtnIcon.textContent  = loading ? '⏳' : '▶';
    dom.permBtnText.textContent  = loading
      ? 'Starting AR Scout…'
      : 'Start AR Scout';
  },

  showPermError(msg) {
    dom.permissionError.textContent = msg;
    dom.permissionError.classList.remove('hidden');
  },

  // Moon position, phase, illumination bar, and rise/set
  updateMoon({ azimuth, elevation, illumination, phaseName, phaseEmoji, rise, set }) {
    dom.moonAzimuthDisplay.textContent   = `${azimuth.toFixed(1)}°`;
    dom.moonElevationDisplay.textContent = `${elevation.toFixed(1)}°`;
    dom.moonPhaseEmoji.textContent       = phaseEmoji;
    dom.moonPhaseName.textContent        = phaseName;
    dom.moonIllumination.textContent     = `${Math.round(illumination * 100)} % illuminated`;
    dom.moonRiseDisplay.textContent      = `↑ Moonrise ${fmtTime(rise)}`;
    dom.moonSetDisplay.textContent       = `↓ Moonset  ${fmtTime(set)}`;
    dom.moonIllumBar.style.width         = `${Math.round(illumination * 100)}%`;
  },

  // Rotate moon AR arrow toward the moon's position relative to camera heading
  updateMoonArrow(moonAzimuth, deviceHeading) {
    if (moonAzimuth === null || deviceHeading === null) return;
    const relative = (moonAzimuth - deviceHeading + 360) % 360;
    dom.moonArrow.style.transform       = `rotate(${relative}deg)`;
    dom.moonDirectionLabel.textContent  = `${this._toCardinal(moonAzimuth)}  ${moonAzimuth.toFixed(0)}°`;
    dom.moonDirectionWrap.style.opacity = '1';
  },

  // Render visible planet rows in the Sky tab
  updatePlanets(planets) {
    // Clear previous planet rows (leave the empty-message element in place)
    dom.planetsList.querySelectorAll('.planet-row').forEach(r => r.remove());

    if (planets.length === 0) {
      dom.planetsEmpty.textContent = state.coords
        ? 'No planets above the horizon right now.'
        : 'Waiting for GPS fix…';
      dom.planetsEmpty.classList.remove('hidden');
      return;
    }

    dom.planetsEmpty.classList.add('hidden');

    planets.forEach(({ name, icon, color, azimuth, elevation }) => {
      const cardinal = this._toCardinal(azimuth);
      const note     = elevation < 10 ? ' · low on horizon' : '';
      const row      = document.createElement('div');
      row.className  = 'planet-row flex items-center gap-3 bg-slate-800/50 rounded-lg px-3 py-2.5';
      row.innerHTML  = `
        <span class="${color} text-base w-5 text-center leading-none">${icon}</span>
        <span class="text-slate-200 text-sm font-semibold w-16">${name}</span>
        <span class="text-slate-400 font-mono text-xs tabular-nums">↑ ${elevation.toFixed(1)}°</span>
        <span class="text-slate-400 font-mono text-xs tabular-nums">→ ${azimuth.toFixed(1)}°</span>
        <span class="text-slate-500 text-xs">${cardinal}${note}</span>`;
      dom.planetsList.appendChild(row);
    });
  },

  // Build the day's light schedule chips from SunCalc.getTimes() output
  updateLightSchedule(times) {
    if (!dom.lightScheduleRow) return;

    const now = new Date();

    // The 7 key film-production events in chronological order
    const events = [
      { key: 'dawn',          label: 'DAWN',  icon: '🔵', color: 'text-sky-400'    },
      { key: 'sunrise',       label: 'RISE',  icon: '🌅', color: 'text-orange-400' },
      { key: 'goldenHourEnd', label: 'GLD↑',  icon: '✦',  color: 'text-amber-400'  },
      { key: 'solarNoon',     label: 'NOON',  icon: '☀',  color: 'text-yellow-300' },
      { key: 'goldenHour',    label: 'GLD↓',  icon: '✦',  color: 'text-amber-400'  },
      { key: 'sunset',        label: 'SET',   icon: '🌇', color: 'text-orange-400' },
      { key: 'dusk',          label: 'DUSK',  icon: '🔵', color: 'text-sky-400'    },
    ];

    // The "active" index is the last event whose time has already passed —
    // i.e. the period we're currently inside.
    let activeIdx = -1;
    events.forEach((ev, i) => {
      if (times[ev.key] instanceof Date && times[ev.key] <= now) activeIdx = i;
    });

    dom.lightScheduleRow.innerHTML = events.map(({ key, label, icon, color }, i) => {
      const t       = times[key];
      const timeStr = t instanceof Date
        ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })
        : '--:--';

      const isPast   = activeIdx >= 0 && i < activeIdx;
      const isActive = i === activeIdx;

      const bg      = isActive ? 'bg-amber-900/60 border border-amber-600/50' : 'bg-slate-800/50';
      const opacity = isPast   ? 'opacity-30' : '';

      return `<div class="flex-shrink-0 flex flex-col items-center gap-0.5 px-2.5 py-2 rounded-lg ${bg} ${opacity} min-w-[56px]">
        <span class="text-sm leading-none">${icon}</span>
        <span class="text-[10px] font-semibold tracking-wide ${color}">${label}</span>
        <span class="text-white font-mono text-[11px] tabular-nums">${timeStr}</span>
      </div>`;
    }).join('');

    dom.lightScheduleSection.classList.remove('hidden');
  },

  // Convert 0–360 degrees to a 16-point cardinal string
  _toCardinal(deg) {
    const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                 'S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return pts[Math.round(deg / 22.5) % 16];
  },
};


// ================================================================
// SAVE MODULE
//
// ┌────────────────────────────────────────────────────────────────┐
// │  SUPABASE INTEGRATION                                          │
// │                                                                │
// │  1. Add to index.html (before app.js):                        │
// │     <script src="https://cdn.jsdelivr.net/npm/@supabase/      │
// │       supabase-js@2/dist/umd/supabase.min.js"></script>       │
// │                                                                │
// │  2. Replace YOUR_SUPABASE_URL and YOUR_SUPABASE_ANON_KEY      │
// │     (use environment variable injection at build time or a     │
// │     runtime config object loaded from a separate config.js)   │
// │                                                                │
// │  3. Create a `location_scouts` table with columns matching     │
// │     the `record` object below.                                 │
// │                                                                │
// │  4. Uncomment the Supabase block in save() below.             │
// └────────────────────────────────────────────────────────────────┘
//
// ┌────────────────────────────────────────────────────────────────┐
// │  NOTION API INTEGRATION                                        │
// │                                                                │
// │  Endpoint: POST https://api.notion.com/v1/pages               │
// │  Auth:     Authorization: Bearer <NOTION_INTEGRATION_TOKEN>   │
// │  Version:  Notion-Version: 2022-06-28                         │
// │                                                                │
// │  NOTE: Notion's API does not allow direct browser requests     │
// │  (CORS). You'll need a small server-side proxy (a Vercel      │
// │  serverless function or Supabase Edge Function works well).   │
// └────────────────────────────────────────────────────────────────┘
//
// ┌────────────────────────────────────────────────────────────────┐
// │  CLICKUP API INTEGRATION                                       │
// │                                                                │
// │  Endpoint: POST https://api.clickup.com/api/v2/               │
// │                 list/{LIST_ID}/task                            │
// │  Auth:     Authorization: <CLICKUP_API_KEY>                   │
// │                                                                │
// │  ClickUp supports direct CORS requests — you can call this    │
// │  from the browser if you keep the API key server-side or use  │
// │  a public workspace token (for non-sensitive scouts).         │
// └────────────────────────────────────────────────────────────────┘

const saveModule = {

  async save() {
    if (!state.coords) {
      alert('No GPS fix yet.\nWait for the coordinates to appear, then try again.');
      return;
    }

    // Build the record — columns match the location_scouts table exactly
    const record = {
      latitude:          state.coords.latitude,
      longitude:         state.coords.longitude,
      gps_accuracy_m:    Math.round(state.coords.accuracy),
      compass_heading:   state.heading  !== null ? Math.round(state.heading)           : null,
      sun_azimuth_deg:   state.sun.azimuth   !== null ? +state.sun.azimuth.toFixed(2)   : null,
      sun_elevation_deg: state.sun.elevation !== null ? +state.sun.elevation.toFixed(2) : null,
      // Optional film metadata — populate these before calling save()
      // or wire them to input fields in the UI:
      // production_name: null,
      // scene_number:    null,
      // shot_type:       null,  // 'wide' | 'medium' | 'close'
      // notes:           null,
    };

    // Loading state
    dom.btnSave.disabled       = true;
    dom.saveBtnIcon.textContent = '⏳';
    dom.saveBtnText.textContent = 'Saving…';

    try {
      // ── Supabase insert ─────────────────────────────────────────
      const { data, error } = await getDB()
        .from('location_scouts')
        .insert(record)
        .select('id, created_at')
        .single();

      if (error) throw new Error(error.message);

      console.log('[Save] Saved to Supabase:', data.id);

      dom.saveBtnIcon.textContent = '✅';
      dom.saveBtnText.textContent = 'Saved!';

      // ── NOTION PLACEHOLDER ──────────────────────────────────────
      // Notion's API blocks CORS, so you need a thin proxy (e.g. a
      // Supabase Edge Function). Uncomment once the proxy is live:
      //
      // await fetch('/api/notion-proxy', {
      //   method:  'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({
      //     scout_id: data.id,
      //     ...record,
      //   }),
      // });

      // ── CLICKUP PLACEHOLDER ─────────────────────────────────────
      // ClickUp allows direct browser requests — just supply keys:
      //
      // const CLICKUP_API_KEY = 'YOUR_KEY';
      // const CLICKUP_LIST_ID = 'YOUR_LIST_ID';
      // await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, {
      //   method: 'POST',
      //   headers: { 'Authorization': CLICKUP_API_KEY, 'Content-Type': 'application/json' },
      //   body: JSON.stringify({ name: `Scout — ${data.created_at}`, description: JSON.stringify(record, null, 2) }),
      // });

    } catch (err) {
      console.error('[Save] Failed:', err.message);
      dom.saveBtnIcon.textContent = '❌';
      dom.saveBtnText.textContent = 'Save failed — tap to retry';
    } finally {
      // Re-enable button after 2.5 s regardless of outcome
      setTimeout(() => {
        dom.btnSave.disabled        = false;
        dom.saveBtnIcon.textContent = '💾';
        dom.saveBtnText.textContent = 'Save Location Scout';
      }, 2_500);
    }
  },
};


// ================================================================
// PERMISSIONS MODULE
// Must be triggered from a user gesture (button click) on iOS.
// Orchestrates camera → compass → GPS in that order so that the
// iOS DeviceOrientationEvent.requestPermission() call still sits
// within the synchronous user-gesture event boundary.
// ================================================================
const permModule = {

  async request() {
    uiModule.setPermBtnLoading(true);
    dom.permissionError.classList.add('hidden');

    try {
      // ── 1. Camera ───────────────────────────────────────────────
      // getUserMedia triggers its own OS permission sheet.
      const cameraOk = await cameraModule.start();

      // ── 2. Compass (iOS 13+ needs gesture context — call here) ──
      // This is still inside the event tick started by the button click,
      // which satisfies iOS's user-gesture requirement.
      await compassModule.requestPermission();

      // ── 3. GPS ──────────────────────────────────────────────────
      // geolocation.watchPosition will show the OS location sheet.
      gpsModule.start();

      // ── Reveal data card ────────────────────────────────────────
      // Camera is optional — GPS + compass data works without it.
      // Desktop browsers and denied camera still show full data.
      state.permissionsGranted = true;
      uiModule.showDataSection();
      // Show banner if heading never arrived (permission denied or not supported)
      setTimeout(() => {
        if (state.heading === null) uiModule.showCompassBanner();
      }, 1500);
      if (!cameraOk) {
        // CAM dot stays red; subtle notice replaces the error block
        console.info('[Permissions] Camera unavailable — running in data-only mode.');
      }

    } catch (err) {
      console.error('[Permissions] Unexpected error:', err);
      uiModule.showPermError(`Unexpected error: ${err.message}`);
      uiModule.setPermBtnLoading(false);
    }
  },
};


// ================================================================
// SHEET MODULE
// Drag-to-collapse bottom panel. Swipe down → shows only the tab
// bar + handle so the AR camera is unobstructed. Swipe up or tap
// the handle to expand back to full height.
// ================================================================
const sheetModule = {

  _main:           null,
  _chevron:        null,
  _dragging:       false,
  _startY:         0,
  _startTranslate: 0,
  _currentY:       0,
  _expanded:       true,
  _SNAP_VISIBLE:   64,   // px of card visible when collapsed (handle + tab bar)
  _TRANSITION:     'transform 0.38s cubic-bezier(0.32, 0.72, 0, 1)',

  init() {
    this._main    = document.getElementById('bottom-sheet');
    this._chevron = document.getElementById('sheet-chevron');
    const handle  = document.getElementById('sheet-handle');
    if (!this._main || !handle) return;

    this._main.style.transition = this._TRANSITION;

    handle.addEventListener('touchstart', (e) => {
      this._dragging      = true;
      this._startY        = e.touches[0].clientY;
      this._startTranslate = this._currentY;
      this._main.style.transition = 'none';

      const onMove = (ev) => {
        if (!this._dragging) return;
        ev.preventDefault();
        const dy  = ev.touches[0].clientY - this._startY;
        const max = this._maxY();
        this._currentY = Math.max(0, Math.min(max, this._startTranslate + dy));
        this._main.style.transform = `translateY(${this._currentY}px)`;
      };

      const onEnd = () => {
        this._dragging = false;
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend',  onEnd);
        this._snap();
      };

      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend',  onEnd);
    }, { passive: true });

    // Tap handle to toggle
    handle.addEventListener('click', () => this.toggle());
  },

  toggle() {
    this._expanded = !this._expanded;
    this._snap();
  },

  expand() {
    this._expanded = true;
    this._snap();
  },

  _maxY() {
    return Math.max(0, this._main.offsetHeight - this._SNAP_VISIBLE);
  },

  _snap() {
    const target = this._expanded ? 0 : this._maxY();
    this._currentY = target;
    this._main.style.transition = this._TRANSITION;
    this._main.style.transform  = `translateY(${target}px)`;
    if (this._chevron) {
      this._chevron.style.transform = this._expanded ? 'rotate(0deg)' : 'rotate(180deg)';
    }
  },
};


// ================================================================
// PUBLIC API
// Exposed on `window.App` so the inline onclick attributes in
// index.html can reach module methods without polluting global scope.
// ================================================================
window.App = {
  requestPermissions: () => permModule.request(),
  retryCompass:       () => compassModule.requestPermission(),
  saveLocation:       () => saveModule.save(),
  switchTab:          (name) => { tabModule.switch(name); sheetModule.expand(); },
  toggleSheet:        ()     => sheetModule.toggle(),
  toggleArPath:       (key)  => arOverlayModule.togglePath(key),
  toggleMoonPath:     (key)  => arOverlayModule.toggleMoonPath(key),
  setArCustomDate:    (val)  => arOverlayModule.setCustomDate(val),
};


// ================================================================
// INIT
// Minimal startup — no auto-requests. iOS requires that all sensor
// permissions are triggered by an explicit user gesture, so we
// simply let the page render with the permission button visible.
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] Wilan Sun Tracker — ready. Waiting for user gesture to start sensors.');
  skyChartModule.init();
  arOverlayModule.init();
  sheetModule.init();
});
