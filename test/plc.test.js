// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPLC } = require("../plc.js");

const base = { start: false, stop: false, reset: false, estop: false, sensor: false, colour: null, encoder: 0 };
const run = (plc, inputs, scans = 1) => { let o; for (let i = 0; i < scans; i++) o = plc.scan({ ...base, ...inputs }, 10); return o; };

test("starts idle with every output off", () => {
  const plc = createPLC();
  const o = run(plc, {});
  assert.equal(plc.state, "IDLE");
  assert.deepEqual(o, { motor: false, pushRed: false, pushBlue: false, lampRun: false, lampFault: false });
});

test("start runs the motor and stop halts it", () => {
  const plc = createPLC();
  assert.equal(run(plc, { start: true }).motor, true);
  assert.equal(run(plc, {}).motor, true, "start is a momentary button, the state machine holds RUNNING");
  assert.equal(run(plc, { stop: true }).motor, false);
  assert.equal(plc.state, "IDLE");
});

test("start is ignored while stop is held", () => {
  const plc = createPLC();
  run(plc, { start: true, stop: true });
  assert.equal(plc.state, "IDLE");
});

test("a red part fires the red pusher exactly when it reaches it", () => {
  const plc = createPLC();
  run(plc, { start: true });
  run(plc, { sensor: true, colour: "red", encoder: 100 });
  run(plc, { encoder: 150 });
  assert.equal(run(plc, { encoder: 319 }).pushRed, false, "not there yet");
  const o = run(plc, { encoder: 320 });
  assert.equal(o.pushRed, true);
  assert.equal(o.pushBlue, false);
  assert.equal(plc.counts.red, 1);
});

test("the pusher retracts after the push time", () => {
  const plc = createPLC({ pushTimeMs: 100 });
  run(plc, { start: true });
  run(plc, { sensor: true, colour: "blue", encoder: 0 });
  run(plc, { encoder: 360 });
  assert.equal(run(plc, { encoder: 360 }, 8).pushBlue, true);
  assert.equal(run(plc, { encoder: 360 }, 3).pushBlue, false);
});

test("holding the sensor counts one part, not one per scan", () => {
  const plc = createPLC();
  run(plc, { start: true });
  run(plc, { sensor: true, colour: "green", encoder: 0 }, 20);
  assert.equal(plc.counts.green, 1);
});

test("parts are tracked in order even when they overtake in the queue", () => {
  const plc = createPLC();
  run(plc, { start: true });
  run(plc, { sensor: true, colour: "blue", encoder: 0 });   // blue due at 360
  run(plc, { sensor: false, encoder: 50 });
  run(plc, { sensor: true, colour: "red", encoder: 60 });   // red due at 280, before the blue
  run(plc, { sensor: false, encoder: 70 });
  assert.deepEqual(plc.queues, { red: [280], blue: [360] });
  assert.equal(run(plc, { encoder: 280 }).pushRed, true);
  assert.equal(run(plc, { encoder: 300 }).pushBlue, false);
  run(plc, { encoder: 360 }, 40);
  assert.deepEqual(plc.counts, { red: 1, blue: 1, green: 0, dropped: 0 });
});

test("emergency stop latches: releasing it is not enough, reset is needed", () => {
  const plc = createPLC();
  run(plc, { start: true });
  run(plc, { sensor: true, colour: "red", encoder: 0 });
  const o = run(plc, { estop: true });
  assert.equal(o.motor, false);
  assert.equal(o.lampFault, true);
  assert.deepEqual(plc.queues, { red: [], blue: [] }, "queues are cleared, parts must be removed by hand");
  run(plc, { start: true });
  assert.equal(plc.state, "FAULT", "start does nothing in FAULT");
  run(plc, { reset: true, estop: true });
  assert.equal(plc.state, "FAULT", "reset does nothing while E-STOP is still pressed");
  run(plc, { reset: true });
  assert.equal(plc.state, "IDLE");
  assert.equal(run(plc, {}).motor, false, "the line does not restart by itself");
});

test("a full queue counts dropped parts instead of overwriting", () => {
  const plc = createPLC({ queueSize: 2 });
  run(plc, { start: true });
  for (let i = 0; i < 3; i++) { run(plc, { sensor: true, colour: "red", encoder: i * 10 }); run(plc, { encoder: i * 10 + 5 }); }
  assert.equal(plc.queues.red.length, 2);
  assert.equal(plc.counts.dropped, 1);
});
