/*
 * Conveyor sorter: PLC program logic.
 *
 * A line-for-line JavaScript port of src/ConveyorSorter/Cyclic.st, so the
 * browser simulator runs the same decisions the real PLC would make.
 * One call to scan() = one PLC cycle.
 *
 * Inputs  (all BOOL unless stated)
 *   start, stop, reset   HMI push buttons (TRUE while pressed)
 *   estop                emergency stop (TRUE = pressed / circuit open)
 *   sensor               photo-eye at the colour station
 *   colour               "red" | "blue" | "green" from the colour sensor
 *   encoder              DINT, belt position in encoder counts
 *
 * Outputs
 *   motor, pushRed, pushBlue, lampRun, lampFault
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SorterPLC = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STATE = Object.freeze({ IDLE: 0, RUNNING: 1, FAULT: 2 });
  const STATE_NAME = ["IDLE", "RUNNING", "FAULT"];

  const DEFAULTS = {
    redOffset: 220,   // encoder counts from colour sensor to red pusher
    blueOffset: 360,  // encoder counts from colour sensor to blue pusher
    pushTimeMs: 350,  // how long a pusher stays out
    queueSize: 16     // ring buffer size per pusher (same as the ST array)
  };

  /** Fixed-size FIFO, like the ARRAY[0..15] OF DINT ring buffer in the ST code. */
  function ring(size) {
    const buf = new Array(size).fill(0);
    let head = 0, count = 0;
    return {
      push(v) { if (count >= size) return false; buf[(head + count) % size] = v; count++; return true; },
      peek() { return buf[head]; },
      shift() { const v = buf[head]; head = (head + 1) % size; count--; return v; },
      clear() { head = 0; count = 0; },
      get length() { return count; },
      toArray() { return Array.from({ length: count }, (_, i) => buf[(head + i) % size]); }
    };
  }

  function createPLC(config = {}) {
    const cfg = { ...DEFAULTS, ...config };
    let state = STATE.IDLE;
    let prevSensor = false;
    const queue = { red: ring(cfg.queueSize), blue: ring(cfg.queueSize) };
    const pusher = { red: { on: false, ms: 0 }, blue: { on: false, ms: 0 } };
    const counts = { red: 0, blue: 0, green: 0, dropped: 0 };

    function scan(i, dtMs) {
      // 1. Emergency stop has priority over everything and latches FAULT.
      if (i.estop) {
        state = STATE.FAULT;
        queue.red.clear(); queue.blue.clear();
        pusher.red.on = pusher.blue.on = false;
      }

      // 2. State machine.
      switch (state) {
        case STATE.IDLE:    if (i.start && !i.stop) state = STATE.RUNNING; break;
        case STATE.RUNNING: if (i.stop) state = STATE.IDLE; break;
        case STATE.FAULT:   if (!i.estop && i.reset) state = STATE.IDLE; break;
      }

      // 3. Tracking: on the rising edge of the photo-eye, remember where the
      //    part will be when it reaches its pusher.
      const edge = i.sensor && !prevSensor;
      prevSensor = !!i.sensor;
      if (state === STATE.RUNNING && edge) {
        if (i.colour === "red" || i.colour === "blue") {
          const target = i.encoder + (i.colour === "red" ? cfg.redOffset : cfg.blueOffset);
          if (!queue[i.colour].push(target)) counts.dropped++;
        } else {
          counts.green++; // green parts ride to the end of the belt
        }
      }

      // 4. Fire a pusher when the belt has moved the part in front of it.
      for (const c of ["red", "blue"]) {
        const p = pusher[c];
        if (state !== STATE.FAULT && !p.on && queue[c].length && i.encoder >= queue[c].peek()) {
          queue[c].shift(); p.on = true; p.ms = 0; counts[c]++;
        }
        if (p.on) { p.ms += dtMs; if (p.ms >= cfg.pushTimeMs) p.on = false; }
      }

      return {
        motor: state === STATE.RUNNING,
        pushRed: pusher.red.on,
        pushBlue: pusher.blue.on,
        lampRun: state === STATE.RUNNING,
        lampFault: state === STATE.FAULT
      };
    }

    return {
      scan,
      config: cfg,
      get state() { return STATE_NAME[state]; },
      get counts() { return { ...counts }; },
      get queues() { return { red: queue.red.toArray(), blue: queue.blue.toArray() }; }
    };
  }

  return { createPLC, STATE_NAME, DEFAULTS };
});
