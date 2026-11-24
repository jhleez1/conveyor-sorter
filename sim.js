/*
 * Conveyor sorter: physics, drawing and HMI.
 * The PLC logic lives in plc.js; this file only plays the role of the
 * machine (belt, sensors, pushers) and the operator panel.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ---- Machine layout (1 px = 1 mm = 1 encoder count) ----------------------
  const W = 900, H = 300;
  const BELT = { x0: 30, x1: 840, y: 112, h: 44 };
  const SENSOR_X = 180;
  const PART = 26;
  const plc = SorterPLC.createPLC();
  const PUSHER = { red: SENSOR_X - PART / 2 + plc.config.redOffset + 13, blue: SENSOR_X - PART / 2 + plc.config.blueOffset + 13 };
  const BIN = { red: PUSHER.red, blue: PUSHER.blue, green: 860 };
  const COLOURS = { red: "#ef5350", blue: "#42a5f5", green: "#66bb6a" };
  const SCAN_MS = 10;

  // ---- Machine state --------------------------------------------------------
  let parts = [];
  let encoder = 0;
  let spawnTimer = 0;
  let out = { motor: false, pushRed: false, pushBlue: false, lampRun: false, lampFault: false };
  let lastIn = {};
  let estop = false;
  const held = { start: 0, stop: 0, reset: 0 };   // ms left on each momentary button
  const pressing = { start: false, stop: false, reset: false };
  const binned = { red: 0, blue: 0, green: 0 };
  let missorted = 0;
  const sortTimes = [];
  let pusherExt = { red: 0, blue: 0 };          // 0..1 animation

  const speed = () => +$("speed").value;
  const feed = () => +$("feed").value;

  function machineStep(dt) {
    const s = dt / 1000;
    // Belt moves only while the PLC drives the motor output.
    if (out.motor) {
      const d = speed() * s;
      encoder += d;
      for (const p of parts) if (p.state === "belt") p.x += d;
      spawnTimer += s;
      const gap = 60 / feed();
      const last = parts.filter((p) => p.state === "belt").reduce((m, p) => Math.min(m, p.x), Infinity);
      if (spawnTimer >= gap && last > BELT.x0 + PART * 2) {
        spawnTimer = 0;
        const r = Math.random();
        parts.push({ x: BELT.x0 + PART / 2, y: 0, colour: r < 0.36 ? "red" : r < 0.72 ? "blue" : "green", state: "belt" });
      }
    }
    // Pushers: a part in front of an extended pusher gets knocked off the belt.
    for (const c of ["red", "blue"]) {
      const on = c === "red" ? out.pushRed : out.pushBlue;
      pusherExt[c] += (on ? 1 : -1) * s * 8;
      pusherExt[c] = Math.max(0, Math.min(1, pusherExt[c]));
      if (on) for (const p of parts) if (p.state === "belt" && Math.abs(p.x - PUSHER[c]) < 22) { p.state = "pushed"; p.bin = c; }
    }
    for (const p of parts) {
      if (p.state === "pushed") { p.y += 260 * s; if (p.y > 105) { p.state = "done"; binned[p.bin]++; if (p.bin === p.colour) sortTimes.push(performance.now()); else missorted++; } }
      if (p.state === "belt" && p.x > BELT.x1) { p.state = "falling"; }
      if (p.state === "falling") { p.x += 60 * s; p.y += 240 * s; if (p.y > 105) { p.state = "done"; binned.green++; if (p.colour === "green") sortTimes.push(performance.now()); else missorted++; } }
    }
    parts = parts.filter((p) => p.state !== "done");
  }

  function readInputs() {
    const atSensor = parts.find((p) => p.state === "belt" && Math.abs(p.x - SENSOR_X) <= PART / 2);
    return {
      start: held.start > 0 || pressing.start,
      stop: held.stop > 0 || pressing.stop,
      reset: held.reset > 0 || pressing.reset,
      estop,
      sensor: !!atSensor,
      colour: atSensor ? atSensor.colour : null,
      encoder: Math.floor(encoder)
    };
  }

  // ---- Fixed-step loop: machine, then one PLC scan, every 10 ms -------------
  let acc = 0, prev = performance.now();
  function frame(now) {
    acc += Math.min(100, now - prev); prev = now;
    while (acc >= SCAN_MS) {
      machineStep(SCAN_MS);
      lastIn = readInputs();
      out = plc.scan(lastIn, SCAN_MS);
      for (const k in held) held[k] = Math.max(0, held[k] - SCAN_MS);
      acc -= SCAN_MS;
    }
    draw();
    updatePanel();
    requestAnimationFrame(frame);
  }

  // ---- Drawing --------------------------------------------------------------
  const cv = $("belt"), g = cv.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * dpr; cv.height = H * dpr; g.scale(dpr, dpr);

  function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

  function draw() {
    g.clearRect(0, 0, W, H);
    // bins
    for (const [c, x] of Object.entries(BIN)) {
      const by = c === "green" ? 190 : 210;
      g.fillStyle = "#1b2430"; rr(x - 34, by, 68, 70, 8); g.fill();
      g.strokeStyle = COLOURS[c]; g.lineWidth = 2; rr(x - 34, by, 68, 70, 8); g.stroke();
      g.fillStyle = COLOURS[c]; g.font = "600 12px ui-monospace, Consolas, monospace"; g.textAlign = "center";
      g.fillText(c.toUpperCase(), x, by + 30); g.fillStyle = "#e6edf3"; g.font = "700 18px ui-monospace, Consolas, monospace";
      g.fillText(binned[c], x, by + 52);
    }
    // belt
    g.fillStyle = "#262f3b"; rr(BELT.x0 - 10, BELT.y - 6, BELT.x1 - BELT.x0 + 20, BELT.h + 12, 22); g.fill();
    g.fillStyle = "#11161d"; g.fillRect(BELT.x0, BELT.y, BELT.x1 - BELT.x0, BELT.h);
    g.strokeStyle = "#1f2731"; g.lineWidth = 2;
    const off = encoder % 24;
    for (let x = BELT.x0 + off; x < BELT.x1; x += 24) { g.beginPath(); g.moveTo(x, BELT.y + 2); g.lineTo(x, BELT.y + BELT.h - 2); g.stroke(); }
    // rollers
    for (const x of [BELT.x0, BELT.x1]) { g.fillStyle = "#3a4656"; g.beginPath(); g.arc(x, BELT.y + BELT.h / 2, 22, 0, 7); g.fill(); }
    // colour sensor + beam
    const beam = lastIn.sensor;
    g.fillStyle = "#3a4656"; rr(SENSOR_X - 14, BELT.y - 46, 28, 26, 5); g.fill();
    g.fillStyle = beam ? COLOURS[lastIn.colour] : "#f0b42955";
    g.fillRect(SENSOR_X - 1.5, BELT.y - 20, 3, BELT.h + 20);
    g.fillStyle = "#8b98a8"; g.font = "600 11px ui-monospace, Consolas, monospace"; g.textAlign = "center";
    g.fillText("COLOUR", SENSOR_X, BELT.y - 54);
    // pushers
    for (const c of ["red", "blue"]) {
      const x = PUSHER[c], e = pusherExt[c];
      g.fillStyle = "#3a4656"; rr(x - 24, 22, 48, 36, 6); g.fill();
      g.fillStyle = "#56657a"; g.fillRect(x - 4, 58, 8, e * 50);
      g.fillStyle = COLOURS[c]; rr(x - 22, 56 + e * 50, 44, 8, 3); g.fill();
      g.fillStyle = "#8b98a8"; g.fillText("PUSH " + c.toUpperCase(), x, 16);
    }
    // parts
    for (const p of parts) {
      const y = BELT.y + BELT.h / 2 + p.y;
      g.fillStyle = COLOURS[p.colour]; rr(p.x - PART / 2, y - PART / 2, PART, PART, 6); g.fill();
      g.fillStyle = "#ffffff30"; rr(p.x - PART / 2 + 4, y - PART / 2 + 4, PART - 8, 6, 3); g.fill();
    }
    // stack light
    const lx = 40, ly = 22;
    g.fillStyle = "#3a4656"; g.fillRect(lx - 2, ly + 40, 4, 40);
    g.fillStyle = out.lampFault && Math.floor(performance.now() / 300) % 2 ? COLOURS.red : "#40262a"; rr(lx - 10, ly, 20, 18, 4); g.fill();
    g.fillStyle = out.lampRun ? COLOURS.green : "#22382a"; rr(lx - 10, ly + 20, 20, 18, 4); g.fill();
  }

  // ---- Operator panel ------------------------------------------------------
  const IO = [
    ["I", "diStart", () => lastIn.start], ["I", "diStop", () => lastIn.stop], ["I", "diReset", () => lastIn.reset],
    ["I", "diEStop", () => lastIn.estop], ["I", "diPartAtSensor", () => lastIn.sensor],
    ["I", "diColourRed", () => lastIn.colour === "red"], ["I", "diColourBlue", () => lastIn.colour === "blue"],
    ["I", "aiEncoder", () => lastIn.encoder],
    ["Q", "doMotor", () => out.motor], ["Q", "doPushRed", () => out.pushRed], ["Q", "doPushBlue", () => out.pushBlue],
    ["Q", "doLampRun", () => out.lampRun], ["Q", "doLampFault", () => out.lampFault]
  ];
  const ioTable = $("ioTable");
  ioTable.innerHTML = IO.map(([d, n]) => `<tr><td>${n}</td><td>${d === "I" ? "input" : "output"}</td><td class="v" data-io="${n}"></td></tr>`).join("");
  const ioCells = [...ioTable.querySelectorAll("[data-io]")];

  const HINTS = {
    IDLE: "Stopped. Press Start to run the line.",
    RUNNING: "Running. Parts are tracked from the colour sensor to their pusher by encoder count.",
    FAULT: "Emergency stop! Release E-STOP, then press Reset."
  };
  function updatePanel() {
    const st = plc.state, c = plc.counts;
    $("stateText").textContent = st;
    $("stateLamp").className = "lamp " + (st === "RUNNING" ? "run" : st === "FAULT" ? "fault" : "");
    $("hint").textContent = estop && st === "FAULT" ? "E-STOP is latched in. Release it first." : HINTS[st];
    $("cRed").textContent = c.red; $("cBlue").textContent = c.blue; $("cGreen").textContent = c.green;
    $("cEnc").textContent = Math.floor(encoder);
    $("cMiss").textContent = missorted;
    const now = performance.now();
    while (sortTimes.length && now - sortTimes[0] > 60000) sortTimes.shift();
    $("cRate").textContent = sortTimes.length;
    IO.forEach(([, , f], i) => { const v = f(); ioCells[i].textContent = typeof v === "number" ? v : v ? "TRUE" : "FALSE"; ioCells[i].className = "v" + (v === true ? " on" : ""); });
    const q = plc.queues;
    $("qRed").textContent = JSON.stringify(q.red); $("qBlue").textContent = JSON.stringify(q.blue);
  }

  // Momentary buttons: TRUE while held, and always for at least a few scans.
  for (const k of ["start", "stop", "reset"]) {
    const b = $("b" + k[0].toUpperCase() + k.slice(1));
    b.addEventListener("pointerdown", () => { pressing[k] = true; held[k] = 60; });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, () => { pressing[k] = false; });
    b.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") held[k] = 60; });
  }
  $("bEstop").addEventListener("click", () => { estop = !estop; $("bEstop").setAttribute("aria-pressed", estop); });
  for (const k of ["speed", "feed"]) { const i = $(k); i.addEventListener("input", () => { $(k + "Out").textContent = i.value; }); }

  // ---- Show the real ST source, lightly highlighted ------------------------
  const KW = /\b(PROGRAM|END_PROGRAM|IF|THEN|ELSIF|ELSE|END_IF|CASE|OF|END_CASE|AND|OR|NOT|MOD|TRUE|FALSE)\b/g;
  const esc = (s) => s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
  function highlight(src) {
    return src.split(/(\(\*[\s\S]*?\*\))/).map((part, i) =>
      i % 2 ? `<span class="cm">${esc(part)}</span>`
            : esc(part).replace(KW, '<span class="kw">$1</span>').replace(/\b(\d+)\b/g, '<span class="num">$1</span>')
    ).join("");
  }
  fetch("src/ConveyorSorter/Cyclic.st").then((r) => { if (!r.ok) throw 0; return r.text(); })
    .then((t) => { $("src").innerHTML = highlight(t); })
    .catch(() => { $("src").innerHTML = 'Open this page from a web server (or GitHub Pages) to see the source here, or read <a href="src/ConveyorSorter/Cyclic.st">Cyclic.st</a>.'; });

  requestAnimationFrame(frame);
})();
