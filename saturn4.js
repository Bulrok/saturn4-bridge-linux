#!/usr/bin/env bun
// saturn4 — talk to the ELEGOO Saturn 4 Ultra over SDCP v3 (LAN, no cloud), zero dependencies.
//
//   saturn4 discover                     find printers (UDP broadcast "M99999" → port 3000)
//   saturn4 status                       print state / layer progress / temperatures
//   saturn4 attrs                        firmware, resolution, capabilities (JSON)
//   saturn4 files [/local|/usb]          list files on the printer
//   saturn4 upload <file.goo|.ctb|.sl1>  copy a sliced file to the printer (.sl1 is converted to .ctb/.goo first)
//   saturn4 print  <name>                start printing a file already on the printer
//   saturn4 send   <file> [--start]      upload, then (with --start) begin the print
//   saturn4 convert <file.sl1>           just convert (+ erode + wait times), no upload
//   saturn4 delete <name>...             remove files from the printer's storage
//   saturn4 pause | resume | stop        control the running print
//
// Options: --ip=<addr>  --format=ctb|goo (for .sl1 conversion, default ctb: GOO cannot carry per-layer settings)  --layer=N  --json  --debug
//          --no-autowait                 skip the area-proportional wait-before-cure (config ~/.config/saturn4/wait.json)
//          --erode=START:END:FIRST-LAST  elephant-foot erode applied after conversion (UVtools Morph, chamfered),
//                                       default from ~/.config/saturn4/erode, else 9:1:0-9 (9→1 px over layers 0-9)
//          --no-erode                    skip it (e.g. parts on supports/pad)
// Printer IP comes from --ip, $SATURN4_IP, ~/.config/saturn4/ip, or discovery (which caches the IP).
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const dgram = require("dgram");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const CFG = path.join(os.homedir(), ".config", "saturn4", "ip");
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => /^--[^=]+$/.test(a)));
const kv = Object.fromEntries(argv.filter(a => /^--[^=]+=/.test(a)).map(a => { const i = a.indexOf("="); return [a.slice(2, i), a.slice(i + 1)]; }));
const args = argv.filter(a => !a.startsWith("--"));
const cmd = args.shift();
const DEBUG = flags.has("--debug");

const STATUS = { 0: "idle", 1: "printing", 2: "file transferring", 3: "exposure test", 4: "device test" };
const PRINT = { 0: "idle", 1: "homing", 2: "dropping", 3: "exposing", 4: "lifting", 5: "pausing", 6: "paused", 7: "stopping", 8: "stopped", 9: "complete", 10: "file checking" };
const ERR = { 0: "ok", 1: "md5 check failed", 2: "file format error", 3: "unknown", 4: "file not found", 5: "file name error", 6: "already printing", 7: "resin low", 8: "printer busy", 9: "no vat/film detected", 10: "print stopped by error", 11: "resin too high", 12: "release film exhausted", 13: "auto-level failed", 14: "temperature out of range", 15: "z-axis limit error", 16: "camera", 17: "network", 18: "mainboard", 19: "usb" };

function die(msg, code = 1) { console.error(msg); process.exit(code); }
function log(...a) { if (DEBUG) console.error("[debug]", ...a); }

// ---------- discovery (UDP) ----------
function discover(timeoutMs = 2500) {
  return new Promise(resolve => {
    const found = new Map();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (msg, rinfo) => {
      try {
        const j = JSON.parse(msg.toString());
        const d = j.Data || {};
        found.set(d.MainboardID || rinfo.address, { id: j.Id, ip: d.MainboardIP || rinfo.address, name: d.MachineName, brand: d.BrandName, fw: d.FirmwareVersion, proto: d.ProtocolVersion, mainboard: d.MainboardID });
      } catch (e) { log("bad discovery packet from", rinfo.address); }
    });
    sock.on("error", () => {});
    sock.bind(() => {
      sock.setBroadcast(true);
      const targets = ["255.255.255.255", ...Object.values(os.networkInterfaces()).flat().filter(i => i.family === "IPv4" && !i.internal).map(i => bcast(i.address, i.netmask))];
      for (const t of new Set(targets)) sock.send("M99999", 3000, t, () => {});
      if (kv.ip) sock.send("M99999", 3000, kv.ip, () => {});
      setTimeout(() => { sock.close(); resolve([...found.values()]); }, timeoutMs);
    });
  });
}
function bcast(ip, mask) { return ip.split(".").map((o, i) => (Number(o) | (~Number(mask.split(".")[i]) & 255))).join("."); }

async function resolveIp() {
  if (kv.ip) return kv.ip;
  if (process.env.SATURN4_IP) return process.env.SATURN4_IP;
  try { const s = fs.readFileSync(CFG, "utf8").trim(); if (s) return s; } catch {}
  const list = await discover();
  const p = list.find(x => /saturn 4 ultra/i.test(x.name || "")) || list[0];
  if (!p) die("No printer found. Is it powered on and on this LAN? Pass --ip=<addr> or set $SATURN4_IP.");
  try { fs.mkdirSync(path.dirname(CFG), { recursive: true }); fs.writeFileSync(CFG, p.ip + "\n"); } catch {}
  return p.ip;
}

// ---------- websocket client ----------
class Printer {
  constructor(ip) { this.ip = ip; this.pending = new Map(); this.info = null; }
  async connect() {
    // A unicast discovery packet gives us Id + MainboardID, which every request must carry.
    const [info] = await new Promise(res => {
      const sock = dgram.createSocket("udp4"); const out = [];
      sock.on("message", m => { try { const j = JSON.parse(m.toString()); out.push({ id: j.Id, mainboard: j.Data.MainboardID, name: j.Data.MachineName, proto: j.Data.ProtocolVersion }); } catch {} });
      sock.bind(() => sock.send("M99999", 3000, this.ip, () => {}));
      setTimeout(() => { sock.close(); res(out); }, 1500);
    });
    if (!info) die(`No SDCP answer from ${this.ip} (UDP 3000). Wrong IP, or printer asleep? Try: saturn4 discover`);
    if (!/^V3/.test(info.proto || "")) die(`Printer speaks SDCP ${info.proto}; this tool needs V3 (websocket).`);
    this.info = info;
    this.ws = new WebSocket(`ws://${this.ip}:3030/websocket`);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("websocket connect timeout")), 8000);
      this.ws.onopen = () => { clearTimeout(t); res(); };
      this.ws.onerror = e => { clearTimeout(t); rej(new Error("websocket error: " + (e.message || e))); };
    });
    this.ws.onmessage = ev => this.onMessage(String(ev.data));
    this.ws.onclose = () => { for (const [, p] of this.pending) p.reject(new Error("connection closed")); this.pending.clear(); };
    return this;
  }
  onMessage(text) {
    let m; try { m = JSON.parse(text); } catch { return; }
    log("<<", m.Topic, JSON.stringify(m).slice(0, 300));
    const topic = m.Topic || "";
    if (topic.startsWith("sdcp/response/")) {
      const p = this.pending.get(m.Data && m.Data.RequestID);
      if (p) { this.pending.delete(m.Data.RequestID); p.resolve(m.Data); }
    } else if (topic.startsWith("sdcp/status/")) { this.lastStatus = m.Status; this.pending.get("status")?.resolve(m.Status); this.pending.delete("status"); }
    else if (topic.startsWith("sdcp/attributes/")) { this.lastAttrs = m.Attributes; this.pending.get("attrs")?.resolve(m.Attributes); this.pending.delete("attrs"); }
    else if (topic.startsWith("sdcp/error/")) { const c = m.Data && m.Data.Data && m.Data.Data.ErrorCode; console.error(`printer error: ${ERR[c] || c}`); }
  }
  waitFor(key, ms = 8000) { return new Promise((resolve, reject) => { const t = setTimeout(() => { this.pending.delete(key); reject(new Error(`timeout waiting for ${key}`)); }, ms); this.pending.set(key, { resolve: v => { clearTimeout(t); resolve(v); }, reject }); }); }
  send(cmdNo, data = {}, ms = 8000) {
    const RequestID = crypto.randomBytes(16).toString("hex");
    const msg = { Id: this.info.id, Data: { Cmd: cmdNo, Data: data, RequestID, MainboardID: this.info.mainboard, TimeStamp: Math.floor(Date.now() / 1000), From: 0 }, Topic: `sdcp/request/${this.info.mainboard}` };
    log(">>", JSON.stringify(msg));
    const p = this.waitFor(RequestID, ms);
    this.ws.send(JSON.stringify(msg));
    return p;
  }
  async status() { const p = this.waitFor("status"); await this.send(0); return p; }
  async attrs() { const p = this.waitFor("attrs"); await this.send(1); return p; }
  async files(dir = "/local") { const r = await this.send(258, { Url: dir }); if (r.Data.Ack !== 0) throw new Error(`file list failed (ack ${r.Data.Ack})`); return r.Data.FileList || []; }
  async start(name, layer = 0) { const r = await this.send(128, { Filename: name, StartLayer: layer }, 15000); if (r.Data.Ack !== 0) throw new Error(`start refused: ${ERR[r.Data.Ack] || "ack " + r.Data.Ack}`); }
  async simple(no, what) { const r = await this.send(no); if (r.Data.Ack !== 0) throw new Error(`${what} refused: ${ERR[r.Data.Ack] || "ack " + r.Data.Ack}`); }
  async del(names) { const r = await this.send(259, { FileList: names, FolderList: [] }); if (r.Data.Ack !== 0) throw new Error(`delete refused (ack ${r.Data.Ack})`); return r.Data; }
  close() { try { this.ws.close(); } catch {} }

  async upload(file) {
    const size = fs.statSync(file).size;
    const name = path.basename(file);
    const md5 = crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");
    const uuid = crypto.randomBytes(32).toString("hex");
    const CHUNK = 1024 * 1024;
    const fh = fs.openSync(file, "r");
    let off = 0, last = -1, result = null;
    process.stderr.write(`uploading ${name} (${(size / 1048576).toFixed(1)} MB) to ${this.ip}\n`);
    try {
      while (off < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - off));
        const n = fs.readSync(fh, buf, 0, buf.length, off);
        const fd = new FormData();
        fd.append("Uuid", uuid); fd.append("Offset", String(off)); fd.append("TotalSize", String(size));
        fd.append("Check", "1"); fd.append("S-File-MD5", md5);
        fd.append("File", new Blob([buf.subarray(0, n)]), name);
        const resp = await fetch(`http://${this.ip}:3030/uploadFile/upload`, { method: "POST", body: fd });
        const body = await resp.text();
        if (!resp.ok) throw new Error(`upload HTTP ${resp.status}: ${body}`);
        try { result = JSON.parse(body); } catch { result = { raw: body }; }
        if (result && result.success === false) throw new Error(`upload rejected: ${body}`);
        off += n;
        const pct = Math.floor(100 * off / size);
        if (pct !== last) { process.stderr.write(`\r  ${pct}%`); last = pct; }
      }
    } finally { fs.closeSync(fh); }
    process.stderr.write("\n");
    log("upload result", result);
    return name;
  }
}

// ---------- helpers ----------
function fmtStatus(st) {
  if (!st) return "no status";
  const cur = (st.CurrentStatus || []).map(c => STATUS[c] ?? c).join(",") || "idle";
  const pi = st.PrintInfo || {};
  const out = [`state:   ${cur}`];
  if (pi.Status !== undefined) {
    out.push(`print:   ${PRINT[pi.Status] ?? pi.Status}${pi.Filename ? "  (" + pi.Filename + ")" : ""}`);
    if (pi.TotalLayer) out.push(`layer:   ${pi.CurrentLayer}/${pi.TotalLayer}  (${(100 * pi.CurrentLayer / pi.TotalLayer).toFixed(1)}%)`);
    if (pi.TotalTicks) out.push(`time:    ${Math.round(pi.CurrentTicks / 60000)} / ${Math.round(pi.TotalTicks / 60000)} min`);
    if (pi.ErrorNumber) out.push(`error:   ${ERR[pi.ErrorNumber] || pi.ErrorNumber}`);
  }
  if (st.TempOfUVLED !== undefined) out.push(`uv led:  ${st.TempOfUVLED} °C`);
  if (st.TempOfBox !== undefined) out.push(`box:     ${st.TempOfBox} °C`);
  if (st.ReleaseFilm !== undefined) out.push(`film:    ${st.ReleaseFilm} releases`);
  return out.join("\n");
}

const ERODE_CFG = path.join(os.homedir(), ".config", "saturn4", "erode");
function erodeSpec() {
  if (flags.has("--no-erode")) return null;
  let spec = kv.erode;
  if (!spec) { try { spec = fs.readFileSync(ERODE_CFG, "utf8").trim(); } catch { spec = "9:1:0-9"; } }
  if (!spec || /^(off|none|0)$/i.test(spec)) return null;
  const m = /^(\d+):(\d+):(\d+)-(\d+)$/.exec(spec);
  if (!m) die(`bad --erode "${spec}", expected START:END:FIRSTLAYER-LASTLAYER, e.g. 7:2:0-9`);
  return { start: +m[1], end: +m[2], first: +m[3], last: +m[4], spec };
}
function uvtoolsBin() { const b = path.join(os.homedir(), ".local", "bin", "uvtoolscmd"); return fs.existsSync(b) ? b : "uvtoolscmd"; }
function applyErode(file) {
  const e = erodeSpec();
  if (!e) return;
  process.stderr.write(`elephant foot: erode ${e.start}→${e.end} px (chamfer) on layers ${e.first}-${e.last}\n`);
  const tmp = file + ".erode.tmp" + path.extname(file);
  const r = spawnSync(uvtoolsBin(), ["run", file, "OperationMorph", "-p", "MorphOperation=Erode", "-p", `IterationsStart=${e.start}`, "-p", `IterationsEnd=${e.end}`,
    "-p", "Chamfer=true", "-p", `LayerIndexStart=${e.first}`, "-p", `LayerIndexEnd=${e.last}`, "-o", tmp], { stdio: ["ignore", DEBUG ? "inherit" : "ignore", "inherit"] });
  let ok = false; try { ok = fs.statSync(tmp).size > 0; } catch {}
  if (!ok) { try { fs.unlinkSync(tmp); } catch {} die(`UVtools erode failed (exit ${r.status})`); }
  fs.renameSync(tmp, file);
}

// ---------- wait-before-cure proportional to layer area ----------
const WAIT_CFG = path.join(os.homedir(), ".config", "saturn4", "wait.json");
const WAIT_DEFAULTS = {
  enabled: true, format: "ctb",
  bottomHeight: 0.5,                                          // mm counted as "bottom" for wait purposes (bottom + transition layers)
  bottom: { secondsPer1000mm2: 10, min: 15, max: 45, maxStep: 5 },
  normal: { secondsPer1000mm2: 2, min: 1.5, max: 8, maxStep: 1 },
  massFrom: "Maximum", massHeight: 0.3,                       // use the largest layer within 0.3 mm below (errs on more wait)
  emptyFirstLayer: true                                        // firmware ignores the wait on layer 0; UVtools inserts a blank one
};
function waitCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(WAIT_CFG, "utf8")); } catch {}
  return { ...WAIT_DEFAULTS, ...c, bottom: { ...WAIT_DEFAULTS.bottom, ...(c.bottom || {}) }, normal: { ...WAIT_DEFAULTS.normal, ...(c.normal || {}) } };
}
function uvProp(file, name, range) {
  const args = ["print-properties", file, "-n", name]; if (range) args.push("-r", range);
  const r = spawnSync(uvtoolsBin(), args, { encoding: "utf8" });
  return (r.stdout || "").split("\n").filter(l => l.startsWith(name + ":")).map(l => l.slice(name.length + 1).trim());
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function applyAutoWait(file) {
  if (flags.has("--no-autowait")) return;
  const c = waitCfg(); if (!c.enabled) return;
  const isCtb = /\.ctb$/i.test(file);
  if (isCtb) {
    // UVtools suggestion: per-layer wait = area(mm²) × coefficient / 1000 mm², clamped, limited step per layer
    process.stderr.write(`wait before cure: per-layer by area (bottom ${c.bottom.min}–${c.bottom.max} s, normal ${c.normal.min}–${c.normal.max} s)\n`);
    const p = ["run", file, "SuggestionWaitTimeBeforeCure",
      "-p", "SetType=ProportionalLayerArea", "-p", `ProportionalCalculateMassFrom=${c.massFrom}`, "-p", `ProportionalMassRelativeHeight=${c.massHeight}`,
      "-p", `BottomHeight=${c.bottomHeight}`,
      "-p", `ProportionalBottomWaitTimeBeforeCure=${c.bottom.secondsPer1000mm2}`, "-p", "ProportionalBottomLayerArea=1000",
      "-p", `ProportionalWaitTimeBeforeCure=${c.normal.secondsPer1000mm2}`, "-p", "ProportionalLayerArea=1000",
      "-p", `ProportionalBottomWaitTimeBeforeCureMaximumDifference=${c.bottom.maxStep}`, "-p", `ProportionalWaitTimeBeforeCureMaximumDifference=${c.normal.maxStep}`,
      "-p", `MinimumBottomWaitTimeBeforeCure=${c.bottom.min}`, "-p", `MaximumBottomWaitTimeBeforeCure=${c.bottom.max}`,
      "-p", `MinimumWaitTimeBeforeCure=${c.normal.min}`, "-p", `MaximumWaitTimeBeforeCure=${c.normal.max}`,
      "-p", `FixedBottomWaitTimeBeforeCure=${c.bottom.max}`, "-p", `FixedWaitTimeBeforeCure=${c.normal.max}`,
      "-p", `CreateEmptyFirstLayer=${c.emptyFirstLayer ? "true" : "false"}`, "-o", file + ".wait.tmp.ctb"];
    const r = spawnSync(uvtoolsBin(), p, { stdio: ["ignore", DEBUG ? "inherit" : "ignore", "inherit"] });
    let ok = false; try { ok = fs.statSync(file + ".wait.tmp.ctb").size > 0; } catch {}
    if (!ok) { try { fs.unlinkSync(file + ".wait.tmp.ctb"); } catch {} die(`UVtools wait-time suggestion failed (exit ${r.status})`); }
    fs.renameSync(file + ".wait.tmp.ctb", file);
  } else {
    // GOO has one wait per group: size it from the largest layer in each group (errs on more wait)
    const n = Number(uvProp(file, "LayerCount")[0] || 0); if (!n) die("could not read layer count");
    const lh = Number(uvProp(file, "LayerHeight")[0] || 0.05);
    const areas = uvProp(file, "Area", `0:${n - 1}`).map(Number);
    const nb = Math.max(1, Math.round(c.bottomHeight / lh));
    const aB = Math.max(...areas.slice(0, nb)), aN = Math.max(...areas);
    const wB = clamp(aB * c.bottom.secondsPer1000mm2 / 1000, c.bottom.min, c.bottom.max).toFixed(1);
    const wN = clamp(aN * c.normal.secondsPer1000mm2 / 1000, c.normal.min, c.normal.max).toFixed(1);
    process.stderr.write(`wait before cure (GOO, whole file): bottom ${wB} s (max bottom area ${aB.toFixed(0)} mm²), normal ${wN} s (max area ${aN.toFixed(0)} mm²)\n`);
    const r = spawnSync(uvtoolsBin(), ["set-properties", file, `BottomWaitTimeBeforeCure=${wB}`, `WaitTimeBeforeCure=${wN}`], { stdio: ["ignore", DEBUG ? "inherit" : "ignore", "inherit"] });
    if (uvProp(file, "WaitTimeBeforeCure")[0] !== String(Number(wN))) die(`setting wait times failed (exit ${r.status})`);
  }
}

function prepareFile(file) {
  if (!fs.existsSync(file)) die(`No such file: ${file}`);
  if (/\.(goo|ctb)$/i.test(file)) return file;
  if (/\.sl1s?$/i.test(file)) {
    const fmt = (kv.format || waitCfg().format || "ctb").toLowerCase();
    if (!["goo", "ctb"].includes(fmt)) die("--format must be ctb or goo");
    const out = file.replace(/\.sl1s?$/i, "." + fmt);
    const bin = path.join(os.homedir(), ".local", "bin", "uvtoolscmd");
    process.stderr.write(`converting ${path.basename(file)} → ${path.basename(out)} with UVtools\n`);
    const t0 = Date.now();
    // UVtoolsCmd exits 1 even after a successful convert, so judge by the output file instead.
    const r = spawnSync(fs.existsSync(bin) ? bin : "uvtoolscmd", ["convert", file, fmt === "ctb" ? "encrypted.ctb" : fmt, out], { stdio: ["ignore", DEBUG ? "inherit" : "ignore", "inherit"] });
    let ok = false;
    try { const st = fs.statSync(out); ok = st.size > 0 && st.mtimeMs >= t0 - 1000; } catch {}
    if (!ok) die(`UVtools conversion failed (exit ${r.status})`);
    applyErode(out);
    applyAutoWait(out);
    return out;
  }
  die(`Unsupported file type ${path.extname(file)} (need .goo, .ctb or PrusaSlicer .sl1)`);
}
const onPrinter = n => n.startsWith("/") ? n : "/local/" + path.basename(n);

(async () => {
  let p;
  try {
    switch (cmd) {
      case "discover": {
        const list = await discover(Number(kv.timeout) || 2500);
        if (flags.has("--json")) return console.log(JSON.stringify(list, null, 2));
        if (!list.length) die("No SDCP printers answered.");
        for (const x of list) console.log(`${x.ip}\t${x.brand} ${x.name}\tfw ${x.fw}\tSDCP ${x.proto}`);
        return;
      }
      case "status": { p = await new Printer(await resolveIp()).connect(); const s = await p.status(); console.log(flags.has("--json") ? JSON.stringify(s, null, 2) : fmtStatus(s)); return; }
      case "attrs": { p = await new Printer(await resolveIp()).connect(); console.log(JSON.stringify(await p.attrs(), null, 2)); return; }
      case "files": {
        p = await new Printer(await resolveIp()).connect();
        const list = await p.files(args[0] || "/local");
        if (flags.has("--json")) return console.log(JSON.stringify(list, null, 2));
        for (const f of list) console.log(`${f.type === 0 ? "d" : "-"}\t${f.name}`);
        return;
      }
      case "convert": { if (!args[0]) die("usage: saturn4 convert <file.sl1> [--format=goo|ctb] [--erode=7:2:0-9|--no-erode]"); console.log(prepareFile(args[0])); return; }
      case "upload": case "send": {
        if (!args[0]) die(`usage: saturn4 ${cmd} <file.goo|.ctb|.sl1>${cmd === "send" ? " [--start]" : ""}`);
        const file = prepareFile(args[0]);
        p = await new Printer(await resolveIp()).connect();
        const st = await p.status();
        if ((st.CurrentStatus || []).includes(1) && flags.has("--start")) die("Printer is already printing; upload without --start instead.");
        const name = await p.upload(file);
        if (cmd === "send" && flags.has("--start")) {
          // the printer verifies the upload (status 2 = file transferring) before it will accept a start
          for (let i = 0; i < 60; i++) {
            const s2 = await p.status();
            if (!(s2.CurrentStatus || []).includes(2)) break;
            if (i === 0) process.stderr.write("waiting for the printer to verify the file");
            process.stderr.write("."); await new Promise(r => setTimeout(r, 2000));
          }
          process.stderr.write("\n");
          await p.start(onPrinter(name), Number(kv.layer) || 0); console.log(`print started: ${name}`);
        }
        else console.log(`uploaded: ${name}  (start it on the printer, or: saturn4 print "${name}")`);
        return;
      }
      case "print": { if (!args[0]) die("usage: saturn4 print <name-on-printer> [--layer=N]"); p = await new Printer(await resolveIp()).connect(); await p.start(onPrinter(args[0]), Number(kv.layer) || 0); console.log(`print started: ${onPrinter(args[0])}`); return; }
      case "delete": { if (!args.length) die("usage: saturn4 delete <name>..."); p = await new Printer(await resolveIp()).connect(); const r = await p.del(args.map(onPrinter)); console.log("deleted" + (r.ErrData && r.ErrData.length ? ` (failed: ${r.ErrData.join(", ")})` : "")); return; }
      case "pause": { p = await new Printer(await resolveIp()).connect(); await p.simple(129, "pause"); console.log("paused"); return; }
      case "resume": { p = await new Printer(await resolveIp()).connect(); await p.simple(131, "resume"); console.log("resumed"); return; }
      case "stop": { p = await new Printer(await resolveIp()).connect(); await p.simple(130, "stop"); console.log("stopped"); return; }
      default:
        { const src = fs.readFileSync(__filename, "utf8").split("\n").slice(1); const end = src.findIndex(l => !l.startsWith("//")); console.log(src.slice(0, end).map(l => l.slice(3)).join("\n")); }
        process.exit(cmd ? 1 : 0);
    }
  } finally { if (p) p.close(); }
})().catch(e => die(`error: ${e && e.message || e}`));
