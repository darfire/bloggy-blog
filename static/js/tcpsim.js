// tcpsim: a round-by-round model of one TCP flow through a bottleneck with
// random loss, for reno and cubic. drop a <div class="tcpsim"></div> into a
// page and load this script.
//
// the model steps one round trip at a time. each round the sender has cwnd
// packets in flight; whatever doesn't fit in the pipe (the BDP) waits in the
// bottleneck queue and adds delay, and whatever doesn't fit in the queue
// either is dropped. on top of that every packet is lost independently with
// probability p. a round with any loss cuts cwnd once - Linux reduces at most
// once per window, however many packets in it were lost - and a round
// without loss grows it by the algorithm's rule.
//
// what it leaves out: loss recovery itself (SACK, RACK, tail loss probes,
// timeouts), delayed ACKs and pacing. it's a model of the window, not of the
// packets.
(function () {
  "use strict";

  const MSS = 1448; // payload bytes per segment
  const WIRE = 1514; // what the bottleneck's rate limit counts, with headers

  // mulberry32, so one seed gives the same loss pattern every time. (plain
  // xorshift won't do: from a small seed its first outputs are tiny, which
  // here means a loss in the very first round of every run)
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // packets until the next random loss: geometric, so the losses form the
  // same Bernoulli process as dropping each packet with probability p, but
  // without drawing a random number per packet
  function nextLossGap(rand, p) {
    if (p <= 0) return Infinity;
    return Math.floor(Math.log(1 - rand()) / Math.log(1 - p)) + 1;
  }

  const reno = {
    init() {
      return {};
    },
    // multiplicative decrease: halve
    onLoss(s) {
      s.ssthresh = Math.max(s.cwnd / 2, 2);
      s.cwnd = s.ssthresh;
    },
    // additive increase: one packet per round trip
    grow(s) {
      s.cwnd += 1;
    },
  };

  // cubic as Linux implements it (net/ipv4/tcp_cubic.c), per round instead
  // of per ACK
  const BETA = 717 / 1024; // cwnd is cut to ~0.7 of itself on loss
  const C = 0.4; // scales the cubic curve, packets / s^3
  // growth of the Reno-friendly estimate, packets per round trip:
  // 3(1 - beta)/(1 + beta) in the RFC, 8/15 after Linux's integer maths
  const FRIENDLY = 8 / 15;
  const cubic = {
    init() {
      return { lastMax: 0, epoch: null, K: 0, origin: 0, wEst: 0 };
    },
    onLoss(s) {
      const c = s.cc;
      c.epoch = null;
      // fast convergence: lost before getting back to the previous peak, so
      // probably competing with someone - aim a little lower this time
      c.lastMax = s.cwnd < c.lastMax ? (s.cwnd * (1 + BETA)) / 2 : s.cwnd;
      s.ssthresh = Math.max(s.cwnd * BETA, 2);
      s.cwnd = s.ssthresh;
    },
    grow(s) {
      const c = s.cc;
      if (c.epoch === null) {
        // first round after a cut: the curve starts here and will be back at
        // the old peak K seconds from now
        c.epoch = s.t;
        c.wEst = s.cwnd;
        if (s.cwnd < c.lastMax) {
          c.K = Math.cbrt((c.lastMax - s.cwnd) / C);
          c.origin = c.lastMax;
        } else {
          c.K = 0;
          c.origin = s.cwnd;
        }
      }
      // where the curve will be one round trip from now
      const t = s.t - c.epoch + s.minRtt;
      const target = c.origin + C * Math.pow(t - c.K, 3);
      // Linux grows at most by half the window per round trip towards the
      // target, and only a token amount when already above it
      let inc = target > s.cwnd ? Math.min(target - s.cwnd, s.cwnd / 2) : 0.01;
      // Reno-friendly region: never slower than what Reno would have reached
      // since the last cut. on short paths with small windows this, not the
      // cubic curve, is what drives the growth
      c.wEst += FRIENDLY;
      if (c.wEst > s.cwnd) inc = Math.max(inc, c.wEst - s.cwnd);
      s.cwnd += inc;
    },
    // HyStart: leave slow start before the queue overflows. returns the
    // window to stop at, or 0 to keep doubling. two checks, as in Linux:
    hystart(s, rtt, rate) {
      // ACK train: once the pipe is full, a round's ACKs come back spaced by
      // the bottleneck. when they take longer than half the minimum RTT to
      // arrive, the window has reached roughly the path's capacity - stop
      // there, half a min RTT's worth of ACKs into the round
      const train = (rate * s.minRtt) / 2;
      if (s.cwnd >= 16 && s.cwnd > train) return s.cwnd + train;
      // delay: the RTT has grown by an eighth of the minimum (clamped to
      // 4..16ms), so a queue is building
      const thresh = Math.min(Math.max(s.minRtt / 8, 0.004), 0.016);
      if (s.cwnd >= 16 && rtt >= s.minRtt + thresh) return s.cwnd;
      return 0;
    },
  };

  const ALGOS = { reno, cubic };

  // one run. returns the averages and, with keepTrace, cwnd per round.
  function simulate(o, seed, keepTrace) {
    const algo = ALGOS[o.algo];
    const rand = rng(seed);
    const p = o.lossPct / 100;
    const R0 = o.rttMs / 1000;
    const rate = (o.rateMbit * 1e6) / (8 * WIRE); // packets per second
    const bdp = rate * R0;
    const Q = o.queuePkts;

    const s = { cwnd: 10, ssthresh: Infinity, t: 0, minRtt: R0, cc: algo.init() };
    let gap = nextLossGap(rand, p);
    let delivered = 0, retrans = 0, queueTime = 0;
    const trace = keepTrace ? [] : null;

    const cap = Math.floor(bdp + Q); // packets the path holds: pipe + queue
    while (s.t < o.seconds) {
      let w = Math.floor(s.cwnd);
      const queue = Math.min(Math.max(w - bdp, 0), Q);
      const rtt = R0 + queue / rate;
      let overflow = Math.max(0, w - cap);
      if (overflow > 0 && s.cwnd < s.ssthresh) {
        // slow start ran past what the path holds. the sender won't see the
        // first drop for another round trip, and until then every ACK still
        // releases two packets, one of which the full queue drops: about a
        // path's worth of drops, and a window twice that by the time it reacts
        overflow = cap;
        w = 2 * cap;
        s.cwnd = w;
      }

      // random losses among the packets that made it into the queue
      let lost = 0;
      let left = w - overflow;
      while (gap <= left) {
        lost++;
        left -= gap;
        gap = nextLossGap(rand, p);
      }
      gap -= left;

      if (trace) trace.push([s.t, s.cwnd, s.ssthresh]);
      delivered += w - overflow - lost;
      retrans += overflow + lost;
      queueTime += (rtt - R0) * rtt;
      s.t += rtt;

      if (overflow + lost > 0) {
        algo.onLoss(s);
      } else if (s.cwnd < s.ssthresh) {
        // slow start: double per round trip
        const stop = algo.hystart ? algo.hystart(s, rtt, rate) : 0;
        if (stop) s.cwnd = s.ssthresh = stop;
        else s.cwnd = Math.min(s.cwnd * 2, s.ssthresh);
      } else {
        algo.grow(s);
      }
    }
    return {
      mbit: (delivered * MSS * 8) / s.t / 1e6,
      queueMs: (queueTime / s.t) * 1000,
      retrans,
      trace,
    };
  }

  // the Mathis et al. (1997) estimate for Reno: MSS/RTT * sqrt(3/2) / sqrt(p),
  // capped at the link's payload rate
  function mathis(o) {
    const cap = (o.rateMbit * MSS) / WIRE;
    if (o.lossPct <= 0) return cap;
    const m = ((MSS * 8) / (o.rttMs / 1000)) * Math.sqrt(1.5) / Math.sqrt(o.lossPct / 100) / 1e6;
    return Math.min(m, cap);
  }

  if (typeof module !== "undefined") {
    module.exports = { simulate, mathis };
    return;
  }

  // ---- the widget ----

  // slider stops. the defaults are the testbed in code/tcp-loss: 20ms RTT,
  // 100Mbit, and netem's limit of 200 packets - of which ~83 are sitting out
  // the 10ms delay at any moment, leaving ~117 of actual queue
  const STOPS = {
    loss: [0, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 2, 5, 10],
    rtt: [5, 10, 20, 50, 100, 200],
    rate: [10, 50, 100, 1000],
    queue: [0, 25, 50, 117, 200, 500, 1000],
  };
  const DEFAULTS = { loss: 0.1, rtt: 20, rate: 100, queue: 117, algos: "reno,cubic" };
  const SECONDS = 20;
  const SEEDS = 20; // runs averaged per algorithm for the numbers

  // Linux 7.2 on the default link (bench.sh cc, one 20s run each), shown
  // next to the model when the sliders are on those settings
  const MEASURED = {
    reno: { 0: 93.4, 0.01: 62.5, 0.1: 24.2, 1: 6.1 },
    cubic: { 0: 95.2, 0.01: 71.6, 0.1: 21.1, 1: 5.5 },
  };

  // the blog's colour scheme exposes colours as "r, g, b" custom properties;
  // fall back to fixed values anywhere else
  const FALLBACK = {
    "--color-primary-500": "139, 92, 246",
    "--color-primary-600": "124, 58, 237",
    "--color-neutral-300": "212, 212, 216",
    "--color-neutral-400": "161, 161, 170",
    "--color-neutral-500": "113, 113, 122",
    "--color-neutral-700": "63, 63, 70",
  };
  function color(name, alpha) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return `rgba(${v || FALLBACK[name]}, ${alpha === undefined ? 1 : alpha})`;
  }
  function dark() {
    return document.documentElement.classList.contains("dark");
  }
  function palette() {
    const d = dark();
    // cubic in the blog's violet, reno in an orange: the scheme's own second
    // colour (fuchsia) is too close to violet for colour-blind readers
    return {
      reno: d ? "#d95926" : "#eb6834",
      cubic: color(d ? "--color-primary-500" : "--color-primary-600"),
      text: color(d ? "--color-neutral-300" : "--color-neutral-700"),
      grid: color(d ? "--color-neutral-500" : "--color-neutral-300", 0.6),
      guide: color(d ? "--color-neutral-400" : "--color-neutral-500"),
    };
  }

  const CSS = `
.tcpsim { margin: 1.5rem 0; font-size: 0.9rem; line-height: 1.4; }
.tcpsim canvas { display: block; width: 100%; height: 260px; }
.tcpsim-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 0.5rem 1.5rem; margin: 0.75rem 0; }
.tcpsim-controls label { display: flex; flex-direction: column; }
.tcpsim-controls input[type=range] { width: 100%; }
.tcpsim-controls .tcpsim-row { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
.tcpsim-controls .tcpsim-row label { flex-direction: row; gap: 0.3rem; align-items: center; }
.tcpsim button { font: inherit; padding: 0.15rem 0.6rem; border-radius: 0.25rem; cursor: pointer;
  border: 1px solid rgba(var(--color-neutral-400, 161, 161, 170), 1); background: transparent; color: inherit; }
.tcpsim-scroll { overflow-x: auto; }
.tcpsim table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; margin: 0; }
.tcpsim th, .tcpsim td { padding: 0.2rem 0.5rem; text-align: right; white-space: nowrap; }
.tcpsim th:first-child, .tcpsim td:first-child { text-align: left; }
.tcpsim .tcpsim-note { opacity: 0.75; font-size: 0.8rem; margin-top: 0.4rem; }
.tcpsim .tcpsim-swatch { display: inline-block; width: 0.8em; height: 0.25em; vertical-align: middle;
  margin-right: 0.4em; border-radius: 1px; }
`;

  function fmtLoss(v) {
    return v === 0 ? "0%" : `${v}%`;
  }

  // a round step size for an axis running up to max, aiming for ~n ticks
  function niceStep(max, n) {
    const raw = max / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
    return 10 * mag;
  }

  function mount(root) {
    const ds = root.dataset;
    const state = {
      loss: ds.loss !== undefined ? +ds.loss : DEFAULTS.loss,
      rtt: ds.rtt !== undefined ? +ds.rtt : DEFAULTS.rtt,
      rate: ds.rate !== undefined ? +ds.rate : DEFAULTS.rate,
      queue: ds.queue !== undefined ? +ds.queue : DEFAULTS.queue,
      algos: new Set((ds.algos || DEFAULTS.algos).split(",")),
      seed: 1,
    };

    root.innerHTML = `
<canvas role="img" aria-label="congestion window over time"></canvas>
<div class="tcpsim-controls">
  ${["loss", "rtt", "rate", "queue"].map((k) => `
  <label><span data-label="${k}"></span>
    <input type="range" data-k="${k}" min="0" max="${STOPS[k].length - 1}" step="1"></label>`).join("")}
  <div class="tcpsim-row">
    <label><input type="checkbox" data-algo="reno"> reno</label>
    <label><input type="checkbox" data-algo="cubic"> cubic</label>
    <button type="button">new loss pattern</button>
  </div>
</div>
<div class="tcpsim-scroll"><table></table></div>
<div class="tcpsim-note">The plot is one run. The table averages ${SEEDS} runs of ${SECONDS}s each,
with the range across them in brackets. A model of the window, not of the packets: no SACK,
RACK, timeouts or delayed ACKs.</div>`;

    const canvas = root.querySelector("canvas");
    const table = root.querySelector("table");
    const inputs = root.querySelectorAll("input[type=range]");
    const boxes = root.querySelectorAll("input[type=checkbox]");

    // snap a preset to the nearest slider stop
    for (const input of inputs) {
      const stops = STOPS[input.dataset.k];
      let best = 0;
      stops.forEach((v, i) => {
        if (Math.abs(v - state[input.dataset.k]) < Math.abs(stops[best] - state[input.dataset.k])) best = i;
      });
      input.value = best;
      state[input.dataset.k] = stops[best];
      input.addEventListener("input", () => {
        state[input.dataset.k] = stops[+input.value];
        update();
      });
    }
    for (const box of boxes) {
      box.checked = state.algos.has(box.dataset.algo);
      box.addEventListener("change", () => {
        if (box.checked) state.algos.add(box.dataset.algo);
        else state.algos.delete(box.dataset.algo);
        update();
      });
    }
    root.querySelector("button").addEventListener("click", () => {
      state.seed++;
      update();
    });

    let traces = {};

    function update() {
      const rate = (state.rate * 1e6) / (8 * WIRE);
      const bdp = rate * (state.rtt / 1000);
      const labels = {
        loss: `random loss: ${fmtLoss(state.loss)}`,
        rtt: `round-trip time: ${state.rtt}ms`,
        rate: `bottleneck: ${state.rate >= 1000 ? state.rate / 1000 + "Gbit" : state.rate + "Mbit"}/s`,
        queue: `queue: ${state.queue} packets (${(state.queue / bdp).toFixed(1)} BDP)`,
      };
      for (const [k, text] of Object.entries(labels))
        root.querySelector(`[data-label=${k}]`).textContent = text;

      const base = {
        lossPct: state.loss, rttMs: state.rtt, rateMbit: state.rate,
        queuePkts: state.queue, seconds: SECONDS,
      };
      const onTestbed = state.rtt === 20 && state.rate === 100 && state.queue === 117;
      const pal = palette();
      const rows = [];
      traces = {};
      for (const algo of ["reno", "cubic"]) {
        if (!state.algos.has(algo)) continue;
        const o = Object.assign({ algo }, base);
        traces[algo] = simulate(o, state.seed, true).trace;
        const runs = [];
        for (let i = 1; i <= SEEDS; i++) runs.push(simulate(o, 1000 + i, false));
        const mbit = runs.map((r) => r.mbit);
        const mean = (f) => runs.reduce((a, r) => a + r[f], 0) / runs.length;
        const measured = onTestbed && MEASURED[algo][state.loss];
        rows.push(`<tr><td><span class="tcpsim-swatch" style="background:${pal[algo]}"></span>${algo}</td>
          <td>${mean("mbit").toFixed(1)} <span style="opacity:.6">[${Math.min(...mbit).toFixed(1)}–${Math.max(...mbit).toFixed(1)}]</span></td>
          <td>${measured === undefined || measured === false ? "–" : measured.toFixed(1)}</td>
          <td>${mean("queueMs").toFixed(1)}</td><td>${Math.round(mean("retrans"))}</td></tr>`);
      }
      const m = mathis(base);
      table.innerHTML = `<thead><tr><th></th><th>model, Mbit/s</th><th>Linux, Mbit/s</th>
        <th>queue, ms</th><th>drops</th></tr></thead><tbody>${rows.join("")}
        <tr><td>Mathis (reno)</td><td>${m.toFixed(1)}</td><td></td><td></td><td></td></tr></tbody>`;
      draw();
    }

    function draw() {
      const pal = palette();
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (!W) return;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = "12px system-ui, sans-serif";

      const rate = (state.rate * 1e6) / (8 * WIRE);
      const bdp = rate * (state.rtt / 1000);
      const cap = bdp + state.queue;
      let ymax = cap;
      for (const t of Object.values(traces)) for (const [, w] of t) ymax = Math.max(ymax, w);
      ymax *= 1.08;

      const L = 52, R = 10, T = 10, B = 28;
      const x = (t) => L + (t / SECONDS) * (W - L - R);
      const y = (w) => H - B - (w / ymax) * (H - T - B);

      // grid and axes
      ctx.strokeStyle = pal.grid;
      ctx.fillStyle = pal.text;
      ctx.lineWidth = 1;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const ys = niceStep(ymax, 4);
      for (let v = 0; v <= ymax; v += ys) {
        ctx.beginPath();
        ctx.moveTo(L, y(v));
        ctx.lineTo(W - R, y(v));
        ctx.stroke();
        ctx.fillText(String(v), L - 6, y(v));
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let t = 0; t <= SECONDS; t += 5) ctx.fillText(`${t}s`, x(t), H - B + 6);
      ctx.save();
      ctx.translate(12, (T + H - B) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = "middle";
      ctx.fillText("cwnd, packets", 0, 0);
      ctx.restore();

      // the path's capacity: below the BDP the link idles part of the time,
      // above BDP + queue the bottleneck drops
      ctx.strokeStyle = pal.guide;
      ctx.fillStyle = pal.guide;
      ctx.setLineDash([3, 3]);
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      for (const [v, label] of [[bdp, "BDP"], [cap, "BDP + queue"]]) {
        if (v > ymax) continue;
        ctx.beginPath();
        ctx.moveTo(L, y(v));
        ctx.lineTo(W - R, y(v));
        ctx.stroke();
        ctx.fillText(label, W - R - 2, y(v) - 2);
      }
      ctx.setLineDash([]);

      // one line per algorithm; cwnd holds for a round, so draw it as steps
      ctx.lineWidth = 1.25;
      for (const [algo, t] of Object.entries(traces)) {
        ctx.strokeStyle = pal[algo];
        ctx.beginPath();
        t.forEach(([ts, w], i) => {
          if (i === 0) ctx.moveTo(x(ts), y(w));
          else ctx.lineTo(x(ts), y(w));
          const next = i + 1 < t.length ? t[i + 1][0] : SECONDS;
          ctx.lineTo(x(Math.min(next, SECONDS)), y(w));
        });
        ctx.stroke();
      }
    }

    update();
    new ResizeObserver(draw).observe(canvas);
    // the blog switches themes by toggling a class on <html>
    new MutationObserver(update).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  function init() {
    if (!document.getElementById("tcpsim-style")) {
      const style = document.createElement("style");
      style.id = "tcpsim-style";
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    document.querySelectorAll(".tcpsim").forEach(mount);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
