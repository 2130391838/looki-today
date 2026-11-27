#!/usr/bin/env node
// 生成「最近 N 天」的加密分享页：index.html（最新一天）+ d/YYYY-MM-DD.html（每天一页）
// 用法：node share.mjs [--days 7] [--out DIR] [--pass 口令] [--date YYYY-MM-DD]
// 口令：--pass 或 env SHARE_PASS；Key：env LOOKI_API_KEY 或 ~/.config/looki/key
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const DAYS = Number(opt("days", "7"));
const OUT = path.resolve(opt("out", path.join(os.homedir(), "个人上下文/share/week")));
const PASS_FROM_ENV = !!process.env.SHARE_PASS;
const PASS = opt("pass", process.env.SHARE_PASS || crypto.randomBytes(9).toString("base64url"));
const ONLY = opt("date", null);
const ITER = 600000;
// 立即刷新信号通道：ntfy.sh 公共 pub-sub，无需鉴权、支持 CORS（浏览器可直接 POST，runner 可轮询）
const RF_TOPIC = "looki-rf-" + crypto.createHash("sha1").update("looki-rf:" + PASS).digest("hex").slice(0, 12);
const RF_BASE = "https://ntfy.sh/";
// 全局固定 salt：页面密文与所有 i/ m/ 二进制共用，客户端只推导一次密钥（否则手机上每张图各跑一遍 PBKDF2）
const GLOBAL_SALT = crypto.createHash("sha256").update("looki-share-v1:" + "salt").digest().subarray(0, 16);
const API = "https://open.looki.tech/api/v1";
const TZ = "Asia/Shanghai";

const key = process.env.LOOKI_API_KEY || (() => {
  const p = path.join(os.homedir(), ".config/looki/key");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").map(s => s.trim()).find(s => s && !s.startsWith("#")) : null;
})();
if (!key) { console.error("缺少 API Key（env LOOKI_API_KEY 或 ~/.config/looki/key）"); process.exit(2); }

const ymd = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d);
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const wdOf = (day) => WD[new Date(`${day}T12:00:00+08:00`).getUTCDay()];
const hhmm = (iso) => iso ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "??:??";
const minutesOf = (iso) => { if (!iso) return 0; const d = new Date(iso); const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(d)); const m = d.getMinutes(); return h * 60 + m; };
const esc = (s = "") => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// 页面内容指纹：忽略生成时间，只有真变才重写文件（避免每 2 小时一次 commit 撑爆仓库）
const generationsEqual = (a, b) => pageSig(a) === pageSig(b);
let _shell = null;
// 外壳指纹：CSS/JS 改了也要重写页面，否则一改样式旧 HTML 就再也刷不新
const shellKey = () => {
  if (_shell) return _shell;
  try { _shell = crypto.createHash("sha1").update(htmlPage({ ct: "", days: [], day: "", title: "", builtAt: "" })).digest("hex").slice(0, 10); }
  catch { _shell = "x"; }
  return _shell;
};
const pageSig = (p) => shellKey() + ":" + stableKey(p);
const stableKey = (p) => {
  const { generatedAt, ...rest } = p;
  return crypto.createHash("sha1").update(JSON.stringify(rest)).digest("hex");
};
const clip = (s, n) => { s = (s || "").trim().replace(/\s+/g, " "); return s.length > n ? s.slice(0, n) + "…" : s; };
const coarse = (loc) => {
  if (!loc) return "";
  let d = loc; try { if (typeof loc === "string") d = JSON.parse(loc); } catch { return clip(loc, 40); }
  return [d.administrativeArea, d.locality].filter(Boolean).join(" · ");
};
const tagsOf = (ctx, n = 4) => {
  if (!ctx) return [];
  return String(ctx).split(/[,，]/).map(s => s.trim()).filter(Boolean).slice(0, n);
};
const durLabel = (min) => min >= 60 ? `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ""}` : `${min} 分钟`;

let lastErr;
async function api(p, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${API}${p}${q ? "?" + q : ""}`, { headers: { "X-API-Key": key, Accept: "application/json" } });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1000 * (i + 1))); continue; }
      if (!r.ok) throw new Error(`${p} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await new Promise(s => setTimeout(s, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function paged(p, params) {
  const out = []; let cursor = null;
  for (let guard = 0; guard < 40; guard++) {
    const j = await api(p, { ...params, cursor });
    const data = j.data || j;
    out.push(...(data.items || []));
    cursor = data.next_cursor || data.nextCursor || null;
    if (!cursor || (data.items || []).length === 0) break;
  }
  return out;
}

// 图片外置：内容寻址（sha1 前 12 位）→ 同一张图永远同名，仓库不会每 2 小时涨 1MB
const IMG_DIR = "i";
function imgKey(buf) { return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12); }

const isWebp = (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";

// 一张图落两个文件：列表只下「勉强看清」的缩略图（5–10K），点开才下高清（16–120K）。
// 内容寻址：前缀固定（t=缩略 / h=高清），名字里的 sha 是压完的字节，换图必换名。
const THUMB_W = 360, THUMB_Q = 45, FULL_W = 900, FULL_Q = 55;

function encImageAt(buf, pass, dir, prefix, maxW, quality) {
  let out = buf;
  if (HAVE_FFMPEG) { const z = ffmpegScale(buf, maxW, quality); if (z) out = z; }
  const rel = `${dir}/${prefix}${imgKey(out)}${isWebp(out) ? ".webp" : ".bin"}`;
  const abs = path.join(OUT, rel);
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, encBinary(out, pass));
  }
  return { rel, out };
}

// 统一成 { img, full, lq, w, h }：老页面只有一张 480 大图时，缩略本地现压、高清就沿用那张
function normPair(v, pass) {
  if (!v) return null;
  if (typeof v === "string") {
    if (!v.startsWith("data:")) return { img: v, full: v, lq: "", w: 0, h: 0 };
    const b64 = v.slice(v.indexOf(",") + 1);
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 100) return null;
    return imgPair(buf, pass);
  }
  let img = v.img || null, full = v.full || null;
  if (img && !full) { full = img; img = thumbOf(img, pass) || img; }   // 旧页只有一张大图：高清沿用，缩略现场压
  if (!img && full) img = thumbOf(full, pass) || full;
  const L = (img && LQIP[img]) || (full && LQIP[full]) || {};
  return { img, full, lq: v.lq || L.q || "", w: v.w || L.w || 0, h: v.h || L.h || 0 };
}

// 源图 → { img: 缩略 rel, full: 高清 rel, lq, w, h }
function imgPair(buf, pass, tw = THUMB_W, tq = THUMB_Q) {
  const L = lqip(buf);
  const t = encImageAt(buf, pass, IMG_DIR, "t", tw, tq);
  const f = encImageAt(buf, pass, IMG_DIR, "h", FULL_W, FULL_Q);
  if (!LQIP[t.rel]) LQIP[t.rel] = L;
  if (!LQIP[f.rel]) LQIP[f.rel] = L;
  console.error(`     图 缩略 ${Math.round(t.out.length / 1024)}K + 高清 ${Math.round(f.out.length / 1024)}K → ${t.rel}`);
  return { img: t.rel, full: f.rel, lq: L.q || "", w: L.w || 0, h: L.h || 0 };
}

async function imgFile(url, pass) {
  if (!url) return null;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (r.status === 403 || r.status === 404) { console.error(`[warn] 图片 ${r.status}（链接可能过期）`); return null; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100) return null;
      return imgPair(buf, pass);
    } catch (e) {
      if (i === 3) { console.error(`[warn] 图片下载失败：${e.message}`); return null; }
      await new Promise(s2 => setTimeout(s2, 1500 * (i + 1)));
    }
  }
  return null;
}

// 旧页里的图还是 data: URI —— 落成内容寻址文件，别继续内嵌进新页
function imgMigrate(v, pass) {
  if (!v) return null;
  if (!String(v).startsWith("data:")) return v;
  const b64 = String(v).slice(String(v).indexOf(",") + 1);
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 100) return null;
  return imgPair(buf, pass);
}

// 旧页只有一张 480 大图：解密本地文件现压一张缩略图，别让老日子一直拿大图当列表图
function thumbOf(rel, pass) {
  try {
    const abs = path.join(OUT, rel);
    if (!abs || !fs.existsSync(abs)) return null;
    return encImageAt(decBinary(fs.readFileSync(abs), pass), pass, IMG_DIR, "t", THUMB_W, THUMB_Q).rel;
  } catch { return null; }
}

// 旧文件本地重压：云端跑一小时也够用，省一次下载和一次等待
function rebuildLocal(rel, isVideo, pass, maxW = 480, q = 52) {
  try {
    const raw = decBinary(fs.readFileSync(path.join(OUT, rel)), pass);
    let out = raw;
    const z = HAVE_FFMPEG ? (isVideo ? ffmpegShrink(raw, true) : ffmpegScale(raw, maxW, q)) : null;
    if (z) out = z;
    if (!isVideo) {
      const L = lqip(out);
      const tag = crypto.createHash("sha1").update(out).digest("hex").slice(0, 8);
      const ext = isWebp(out) ? ".webp" : ".bin";
      const rel2 = `m/${rel.split("/")[1].split("-").slice(0, 2).join("-")}-${tag}${ext}`;
      if (rel2 !== rel) {
        fs.writeFileSync(path.join(OUT, rel2), encBinary(out, pass));
        try { fs.unlinkSync(path.join(OUT, rel)); } catch { }
      }
      return { raw, out, ty: "image/jpeg", extra: { lq: L.q || "", w: L.w || 0, h: L.h || 0 }, rel: rel2 };
    }
    return { raw, out, ty: "video/mp4", extra: {}, rel };
  } catch { return null; }
}

// m/<day>-<kind>.bin 的指纹（URL 路径 + MIME + 尺寸时长），决定要不要重下重压
const MANIFEST = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, "m/manifest.json"), "utf8")); } catch { return {}; }
})();

const MEDIA_V = 10; // 改了压缩参数就 +1，强制重压已有的 .bin（4 = 本地误传原件后，交给云端带 ffmpeg 重压）

const FFMPEG_BIN = (() => {
  const cand = ["ffmpeg", path.join(os.homedir(), "Library/Python/3.9/lib/python/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1")];
  for (const c of cand) { try { execFileSync(c, ["-version"], { stdio: "ignore" }); return c; } catch { /* 下一个 */ } }
  return null;
})();
const HAVE_FFMPEG = !!FFMPEG_BIN;

async function fetchBuf(url, tries = 5) {
  if (!url) return null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (r.status === 403 || r.status === 404) { console.error(`[warn] 媒体 ${r.status}（链接过期）`); return null; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length < 100) throw new Error("内容过小");
      return b;
    } catch (e) {
      if (i === tries - 1) { console.error(`[warn] 媒体下载失败：${e.message}`); return null; }
      await new Promise(s => setTimeout(s, 2000 * (i + 1)));
    }
  }
  return null;
}

// 20px 模糊占位（≈210 字节）+ 真实宽高，让首屏立刻有画面且不跳动
const LQIP = {};
function lqip(buf) {
  if (!HAVE_FFMPEG) return {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lq-"));
  const inF = path.join(tmp, "in"), outF = path.join(tmp, "o.webp");
  try {
    fs.writeFileSync(inF, buf);
    execFileSync(FFMPEG_BIN, ["-y", "-loglevel", "error", "-i", inF, "-vf", "scale='min(32,iw)':-2", "-c:v", "libwebp", "-quality", "45", outF], { stdio: "ignore" });
    const o = fs.readFileSync(outF);
    if (!o.length) return {};
    let w = 0, h = 0;
    const r = spawnSync(FFMPEG_BIN, ["-i", inF, "-frames:v", "0", "-f", "null", "-"], { encoding: "utf8" });
    const m = /,\s*(\d{2,5})x(\d{2,5})/.exec(String((r && r.stderr) || ""));
    if (m) { w = +m[1]; h = +m[2]; }
    return { q: "data:image/webp;base64," + o.toString("base64"), w, h };
  } catch { return {}; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// 压一张图：maxW>0 时等比缩到 maxW 内，=0 时保持原尺寸只调质量
function ffmpegScale(buf, maxW, quality) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-"));
  const inF = path.join(tmp, "in"), outF = path.join(tmp, "o.webp");
  fs.writeFileSync(inF, buf);
  const args = ["-y", "-loglevel", "error", "-i", inF];
  if (maxW > 0) args.push("-vf", `scale='min(${maxW},iw)':-2`);
  args.push("-c:v", "libwebp", "-quality", String(quality), outF);
  try {
    execFileSync(FFMPEG_BIN || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const out = fs.readFileSync(outF);
    return out.length ? out : null;
  } catch { return null; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function decBinary(buf, pass) {
  const salt = buf.subarray(0, 16), iv = buf.subarray(16, 28), ct = buf.subarray(28);
  const k = crypto.pbkdf2Sync(pass, salt, ITER, 32, "sha256");
  const d = crypto.createDecipheriv("aes-256-gcm", k, iv);
  d.setAuthTag(ct.subarray(-16));
  return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
}

function ffmpegShrink(buf, isVideo) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sha-"));
  const inF = path.join(tmp, isVideo ? "in.mp4" : "in.jpg");
  const outF = path.join(tmp, isVideo ? "out.mp4" : "out.webp");
  fs.writeFileSync(inF, buf);
  const args = isVideo
    ? ["-y", "-loglevel", "error", "-i", inF, "-vf", "scale=320:-2,fps=15", "-c:v", "libx264", "-crf", "37", "-preset", "slow", "-c:a", "aac", "-b:a", "24k", "-ac", "1", "-movflags", "+faststart", outF]
    : ["-y", "-loglevel", "error", "-i", inF, "-vf", "scale='min(480,iw)':-2", "-c:v", "libwebp", "-quality", "52", outF];
  try {
    execFileSync(FFMPEG_BIN || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const out = fs.readFileSync(outF);
    return out.length ? out : null;
  } catch (e) {
    console.error(`[warn] ffmpeg 压缩失败：${String(e.stderr || e.message).slice(0, 140)}`);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 媒体文件：salt(16) || iv(12) || ciphertext || tag(16)，自包含，页面用同一口令解开
function encBinary(buf, pass) {
  const salt = GLOBAL_SALT, iv = crypto.randomBytes(12);
  const k = crypto.pbkdf2Sync(pass, salt, ITER, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(buf), c.final(), c.getAuthTag()]);
  return Buffer.concat([salt, iv, ct]);
}

// 抓一个媒体 → 压缩 → 加密 → 落盘 m/<day>-<kind>.bin；内容没变就复用旧文件（不重下、不重加密）
async function buildMedia(day, kind, url, pass, opts = {}) {
  let key = url;
  try { key = new URL(url).pathname; } catch { /* 用原串 */ }
  const prev = MANIFEST[day]?.[kind];
  if (prev && key && prev.key === key && prev.v === MEDIA_V && prev.rel && fs.existsSync(path.join(OUT, prev.rel))) {
    return { p: prev.rel, ty: prev.ty, ...(prev.meta || {}) };
  }
  // 旧构建的残留文件（上一版还在，只是这一轮没记进 manifest）→ 本地解密重压，不重下
  const want = new RegExp(`^${day}-${kind}-[0-9a-f]{8}\\.(webp|mp4|bin)$`);
  for (const f of fs.existsSync(path.join(OUT, "m")) ? fs.readdirSync(path.join(OUT, "m")) : []) {
    if (!want.test(f)) continue;   // 精确匹配，否则 "vlog" 会先命中 "vlog-poster"
    const rel = `m/${f}`;
    const re = rebuildLocal(rel, opts.video, pass, opts.maxW || 480, opts.q || 52);
    if (!re) continue;
    MANIFEST[day] = MANIFEST[day] || {};
    MANIFEST[day][kind] = { key, v: MEDIA_V, rel: re.rel, ty: re.ty, meta: { ...(opts.meta || {}), ...re.extra } };
    console.error(`     媒体 ${kind} 本地重压（${Math.round(re.raw.length / 1024)}K → ${Math.round(re.out.length / 1024)}K）`);
    return { p: re.rel, ty: re.ty, ...(opts.meta || {}), ...re.extra };
  }
  const raw = await fetchBuf(url);
  if (!raw) return null;
  let out = raw;
  const isVideo = !!opts.video;
  if (isVideo ? raw.length > 700000 : !!HAVE_FFMPEG) {
    // 图片：漫画这类成品大图给到 720 宽（手机上 684 设备像素），缩略/海报维持 480
    const z = HAVE_FFMPEG
      ? (isVideo ? ffmpegShrink(raw, true) : ffmpegScale(raw, opts.maxW || 480, opts.q || 52))
      : null;
    if (z) out = z;
  }
  // 文件名带内容指纹：jsDelivr 会长期缓存同一路径，换内容必须换名字，否则一直拿到旧视频
  const tag = crypto.createHash("sha1").update(out).digest("hex").slice(0, 8);
  const ext = isVideo ? ".mp4" : (isWebp(out) ? ".webp" : ".bin");
  const rel = `m/${day}-${kind}-${tag}${ext}`;
  fs.mkdirSync(path.join(OUT, "m"), { recursive: true });
  fs.writeFileSync(path.join(OUT, rel), encBinary(out, pass));
  if (prev && prev.rel && prev.rel !== rel) { try { fs.unlinkSync(path.join(OUT, prev.rel)); } catch { } }
  let extra = {};
  if (!isVideo) { const L = lqip(out); extra = { lq: L.q || "", w: L.w || 0, h: L.h || 0 }; }
  MANIFEST[day] = MANIFEST[day] || {};
  MANIFEST[day][kind] = { key, v: MEDIA_V, rel, ty: isVideo ? "video/mp4" : "image/jpeg", meta: { ...(opts.meta || {}), ...extra } };
  console.error(`     媒体 ${kind} ${Math.round(raw.length / 1024)}K → ${Math.round(out.length / 1024)}K`);
  return { p: rel, ty: isVideo ? "video/mp4" : "image/jpeg", ...(opts.meta || {}), ...extra };
}

// 解密旧页面拿 id → 图片，避免重复下载，也防止偶发下载失败把已有图弄丢
function prevPayload(file, pass) {
  try {
    if (!fs.existsSync(file)) return null;
    const E = JSON.parse((fs.readFileSync(file, "utf8").match(/(?:var|const) E=(\{.*?\});/s) || [])[1] || "null");
    if (!E) return null;
    const k = crypto.pbkdf2Sync(pass, Buffer.from(E.salt, "base64"), ITER, 32, "sha256");
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(E.iv, "base64"));
    const all = Buffer.from(E.ct, "base64");
    d.setAuthTag(all.subarray(-16));
    const j = JSON.parse(Buffer.concat([d.update(all.subarray(0, -16)), d.final()]).toString("utf8"));
    const remember = (o) => {
      if (!o || !o.img) return;
      if (o.lq) LQIP[o.img] = LQIP[o.img] || { q: o.lq, w: o.w || 0, h: o.h || 0 };
      if (o.full && o.lq) LQIP[o.full] = LQIP[o.full] || { q: o.lq, w: o.w || 0, h: o.h || 0 };
    };
    for (const it of j.items || []) remember(it);
    if (j.journal) remember(j.journal);
    return j;
  } catch { return null; }
}

// 旧的 img/full 都带上：增量构建时不重下图片，缺缩略图就本地现压一张
// 复用的老页面：只有一张 480 大图 → 本地现压缩略图，高清沿用那张（不碰网络）
// 复用旧页前先自检：引用的图片/媒体文件是否都在本地，缺了就当作「不对」，当轮重抓
function validDay(p) {
  const bad = [];
  const chkRel = (rel, what) => {
    if (!rel) return;
    if (!/^(i|m)\//.test(rel)) return;
    if (!fs.existsSync(path.join(OUT, rel))) bad.push(`${what}:${rel}`);
  };
  for (const it of p.items || []) {
    if (!it.img || !it.full) bad.push(`item ${it.id} 缺图`);
    chkRel(it.img, "img"); chkRel(it.full, "full");
  }
  if (p.journal) chkRel(p.journal.img, "jrn");
  if (p.comic) chkRel(p.comic.src, "comic");
  if (p.vlog) { chkRel(p.vlog.poster, "poster"); chkRel(p.vlog.src, "vlog"); }
  return bad;
}

function upgradeImgs(p) {
  const up = (o) => {
    if (!o || !o.img || o.full || !o.img.startsWith(IMG_DIR + "/")) return;
    const t = thumbOf(o.img, PASS);
    if (!t) return;
    o.full = o.img; o.img = t;
    const L = LQIP[t]; if (L) { o.lq = o.lq || L.q || ""; o.w = o.w || L.w || 0; o.h = o.h || L.h || 0; }
  };
  for (const it of p.items || []) up(it);
  if (p.journal) up(p.journal);
}

function prevImages(file, pass) {
  const map = new Map();
  const j = prevPayload(file, pass);
  if (!j) return map;
  // 只认「磁盘上真的还在」的文件：以前这里不校验，一旦某张高清没上传成功 / 被剪枝，
  // 页面就会永远指着那个不存在的名字（用户看到的就是「高清图加载失败」）。
  const alive = (r) => (r && r.startsWith(IMG_DIR + "/") && fs.existsSync(path.join(OUT, r)) ? r : null);
  const pairOf = (o) => {
    const img = alive(o.img);
    const full = alive(o.full);
    // 缩略和高清必须都在才算「可用」，缺一个就整对重做（否则页面会指向不存在的文件）
    if (!img || !full) return null;
    return { img, full, lq: o.lq || "", w: o.w || 0, h: o.h || 0 };
  };
  for (const it of j.items || []) if (it.id) { const v = pairOf(it); if (v) map.set(it.id, v); }
  if (j.journal && j.date) { const v = pairOf(j.journal); if (v) map.set("journal:" + j.date, v); }
  return map;
}

function encPage(payload, pass) {
  const salt = GLOBAL_SALT, iv = crypto.randomBytes(12);
  const k = crypto.pbkdf2Sync(pass, salt, ITER, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final(), c.getAuthTag()]);
  return { salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") };
}

const CSS = `
:root{color-scheme:dark;--bg:#0b0c0e;--card:#121417;--line:#1d2025;--tx:#e6e8ea;--dim:#7f8792;--acc:#6ea8fe}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
header{position:sticky;top:0;z-index:30;background:rgba(11,12,14,.94);backdrop-filter:saturate(160%) blur(14px);border-bottom:1px solid var(--line)}
.hd1{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:10px 16px 7px}
.hd1 b{font-size:15px;font-weight:640}
.hd1 span{font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums}
.hd1 span.stale{color:#d9a441}
.chips{display:flex;gap:7px;overflow-x:auto;padding:0 16px 9px;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
/* 7 天一次铺满，不用左右滑也能点全 */
.chips.days7{display:grid;grid-template-columns:repeat(var(--dn,7),minmax(0,1fr));gap:4px;overflow:visible;padding:0 9px 7px}
.chips.days7 button{flex:none;display:flex;flex-direction:column;align-items:center;gap:0;padding:4px 0 3px;border-radius:9px;line-height:1.15}
.chips.days7 button b{font-size:11.5px;font-weight:640;letter-spacing:-.03em}
.chips.days7 button span{font-size:9.5px;opacity:.6}
.chips.days7 button.on span{opacity:.55}
.chips.days7 button.off{opacity:.32;cursor:default}
.hdc{display:flex;align-items:center;gap:7px;min-width:0}
.hdr{display:flex;align-items:center;gap:7px;flex:0 0 auto}
#rfb{flex:0 0 auto;width:24px;height:24px;border-radius:50%;border:1px solid #2a2f37;background:#15181d;color:#8f98a3;font-size:13px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center}
#rfb:active{background:#1d222a;color:#cfe2ff}
#rfb.busy{color:#cfe2ff;border-color:#3a4a63;animation:spin .9s linear infinite}
#rfo[hidden]{display:none}
#rfo{position:fixed;inset:0;z-index:130;background:rgba(6,7,9,.93);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:13px;text-align:center;padding:0 24px}
#rfo .sp2{width:30px;height:30px;border-radius:50%;border:2px solid rgba(255,255,255,.14);border-top-color:#cfe2ff;animation:spin .8s linear infinite}
#rfo b{font-size:14px;color:#d8dde4;font-weight:600}
#rfo span{font-size:12px;color:#7d848e}
#rfn[hidden]{display:none}
#rfn{display:flex;align-items:center;gap:7px;padding:0 16px 7px;font-size:11.5px;color:#cfe2ff}
#rfn i{width:10px;height:10px;border-radius:50%;border:1.6px solid rgba(207,226,255,.25);border-top-color:#cfe2ff;animation:spin .8s linear infinite;display:block;flex:0 0 auto}
.hdc b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#covbtn{flex:0 0 auto;width:24px;height:24px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.05);color:#b9c2cc;font-size:13px;line-height:1;font-family:inherit;cursor:pointer}
#covbtn:active{background:rgba(110,168,254,.18);color:#cfe2ff}
.chips button{flex:0 0 auto;background:transparent;border:1px solid #24282e;color:#98a1ab;border-radius:9px;padding:5px 12px;font-size:12.5px;line-height:1.4;cursor:pointer;font-family:inherit}
.chips button.on{background:var(--tx);border-color:var(--tx);color:#0b0c0e;font-weight:640}
main{max-width:600px;margin:0 auto;padding:16px 16px 88px}
.tab[hidden]{display:none}
#days[hidden],#tabs[hidden],#cov[hidden],#covbtn[hidden]{display:none}
.hd{margin:0 0 9px}
.hd .sub{font-size:11.5px;color:#6f7883;letter-spacing:.01em}
.hd h2{margin:0;font-size:16px;font-weight:640}
.hd .sub{color:var(--dim);font-size:12.5px;margin-top:4px}
section.box{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:14px}
.box .lb{display:flex;justify-content:space-between;padding:9px 14px;font-size:11.5px;color:var(--dim);letter-spacing:.04em;border-bottom:1px solid var(--line)}
.box img{display:block;width:100%;height:auto;max-height:none;background:#0d0f12}
.box.hlimg .bd{border-bottom:1px solid var(--line)}
.moretabs{display:flex;gap:8px;margin:0 0 14px}
.moretabs button{flex:1 1 0;background:var(--card);border:1px solid var(--line);color:#98a1ab;border-radius:10px;padding:10px 6px;font-size:13px;font-family:inherit;cursor:pointer}
.moretabs button.on{background:var(--tx);border-color:var(--tx);color:#0b0c0e;font-weight:640}
.morepane[hidden]{display:none}
.tlst .dx{display:block;margin-top:5px;color:#9aa3ad;font-size:12.5px;line-height:1.5;font-style:normal}
.tlst .dx b{color:#c8ced5;font-weight:600;margin-right:6px}
.tlst .dx em{font-style:normal}

.box .bd{padding:12px 14px 14px}
.box .h{font-weight:640;font-size:15px}
.box p{margin:5px 0 0;color:#b9bec5;font-size:13.5px;white-space:pre-wrap}
.card img{display:block;width:100%;height:auto;max-height:none;background:#0d0f12}
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;overflow:hidden;margin-bottom:12px}
.card.flash{border-color:#3d5d8c;box-shadow:0 0 0 1px rgba(110,168,254,.35)}
.card .t{display:flex;gap:8px;align-items:baseline;padding:11px 14px 0;color:var(--acc);font-size:12px;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.card .t em{font-style:normal;color:#616a75}
.card .h{font-weight:640;font-size:15.5px;padding:3px 14px 0}
.card p{margin:6px 0 0;padding:0 14px;color:#b9bec5;font-size:13.5px;white-space:pre-wrap}
.card .foot{padding:0 14px 13px}
.card p.dc{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card p.dc.open{display:block;-webkit-line-clamp:unset}
.card .more{margin:7px 14px 0;padding:0;background:none;border:0;color:#7aa7e0;font-size:12.5px;font-family:inherit;cursor:pointer}
.card .loc{color:#6b737e;font-size:12px;margin-top:9px}
.del{display:block;margin:2px 14px 13px auto;background:none;border:1px solid var(--line);color:#6b737e;font-size:11.5px;font-family:inherit;padding:6px 12px;border-radius:20px;cursor:pointer}
.del:active{background:#1b1e23;color:#c3c9d1}
.box .del{margin:0 14px 13px auto}
.morepane .del{margin:14px 0 4px auto;display:block}
.cfm{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:24px}
.cfm .bx{background:#15181c;border:1px solid #262a30;border-radius:14px;padding:20px;max-width:320px;width:100%}
.cfm p{margin:0 0 16px;font-size:14px;color:#dfe3e8;line-height:1.6}
.cfm .row{display:flex;gap:10px}
.cfm button{flex:1 1 0;padding:11px;border-radius:10px;border:1px solid #2a2f36;background:#1b1f24;color:#cfd5dc;font-family:inherit;font-size:13.5px;cursor:pointer}
.cfm button.danger{background:#5a2230;border-color:#7d2f42;color:#ffdbe3;font-weight:640}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.tags span{background:#191d22;border:1px solid #232830;border-radius:6px;padding:2px 8px;font-size:11px;color:#8b939e}
.sw{display:flex;gap:12px;align-items:flex-start}
.rail{position:sticky;top:110px;flex:0 0 34px;width:34px;height:min(62vh,470px);margin-top:4px}
/* 一整天 00:00→24:00 的底色：夜里深、清晨偏蓝、正午偏金、傍晚偏紫，扫一眼就知道在哪一段 */
.rail .rc{position:absolute;left:12px;top:0;bottom:0;width:3px;transform:translateX(-50%);border-radius:3px;
 background:linear-gradient(180deg,
  #171b25 0%,#1d2432 12%,#223047 21%,
  #2d4a60 24%,#3c6a79 31%,#578b95 35%,
  #7fa8b4 38%,#b3b58a 44%,#d8b878 48%,
  #e8c078 50%,#e6b96d 53%,
  #cf9a63 56%,#b47c5e 62%,#96635c 69%,
  #7a5064 74%,#5d4066 79%,
  #43335a 84%,#2c2740 90%,#1b1f2b 96%,#171b25 100%)}
.rail .ct{position:absolute;left:0;width:11px;text-align:right;font-size:8.5px;line-height:1;color:#5b6471;transform:translateY(-50%);letter-spacing:-.03em}
.rail .cs{position:absolute;left:8px;width:9px;height:1px;background:rgba(255,255,255,.12);transform:translateY(-50%)}
.rail .rs{position:absolute;left:19px;transform:translateX(-50%);width:9px;border-radius:5px;background:#3b5b85;cursor:pointer;pointer-events:auto;transition:background .18s,width .18s,box-shadow .18s}
.rail .rs.on{width:12px;background:#9dc6ff;box-shadow:0 0 0 4px rgba(110,168,254,.14)}
.rail .rp{position:absolute;left:19px;transform:translate(-50%,-50%);width:20px;height:2px;border-radius:2px;background:#ffca5f;box-shadow:0 0 8px rgba(255,202,95,.55);transition:top .3s cubic-bezier(.3,.9,.3,1);pointer-events:none}
.rail .nm{position:absolute;left:19px;width:7px;height:7px;border-radius:50%;background:#fff;transform:translate(-50%,-50%);box-shadow:0 0 0 2px rgba(255,255,255,.18)}
.sc{flex:1 1 auto;min-width:0}
.segwrap{display:flex;flex-direction:column;height:calc(100dvh - var(--hh,152px));min-height:0}
.segwrap>.seghead{flex:0 0 auto;margin:0 0 7px}
.segwrap>.seghead .sub{color:#6f7883;font-size:11.5px;letter-spacing:.01em}
body.lock .segwrap>.seghead{margin-bottom:4px}
.sw{position:relative;flex:1 1 auto;min-height:0;display:block}
.sw .rail{position:absolute;left:0;top:2px;bottom:2px;width:27px;height:auto;margin:0;z-index:2}
.sw .sc{position:absolute;left:27px;right:0;top:0;bottom:0;overflow-y:auto;overscroll-behavior:contain;padding-bottom:18px;-webkit-overflow-scrolling:touch}
.sw .sc::-webkit-scrollbar{width:0}
.tlst{display:flex;flex-direction:column}
.tlst button{display:flex;gap:12px;width:100%;background:none;border:0;border-top:1px solid var(--line);color:inherit;font-family:inherit;text-align:left;padding:11px 2px;cursor:pointer}
.tlst button:first-child{border-top:0}
.tlst button:active{background:#15181c}
.tlst .tt{flex:0 0 70px;color:var(--acc);font-size:12.5px;font-variant-numeric:tabular-nums;padding-top:1px;white-space:nowrap;letter-spacing:-.01em}
.tlst .nm{flex:1 1 auto;min-width:0;font-size:14px;color:#dfe3e8}
.tlst .nm i{display:block;font-style:normal;color:#6b737e;font-size:12px;margin-top:2px}
.sum{background:#101418;border:1px solid #1b2127;border-radius:14px;padding:13px 15px;margin-bottom:14px}
.sum .lb{font-size:11.5px;color:#7aa7e0;margin-bottom:7px;letter-spacing:.04em}
.sum p{margin:0;color:#b9bec5;font-size:13.5px;white-space:pre-wrap}
.sum .lb{display:flex;justify-content:space-between}
.sum .sums{display:flex;flex-direction:column}
.sum .sm{display:flex;gap:11px;padding:10px 0;border-top:1px solid #1a2027}
.sum .sm:first-child{border-top:0;padding-top:2px}
.sum .st{flex:0 0 88px;color:#7aa7e0;font-size:11.5px;font-variant-numeric:tabular-nums;line-height:1.65;padding-top:1px}
.sum .sx{flex:1 1 auto;min-width:0}
.sum .sx b{display:block;font-size:13px;color:#e6e8ea;font-weight:640;margin-bottom:2px}
.sum .sx p{margin:0;color:#aab1b9;font-size:12.8px;line-height:1.7}
.hl{background:#101418;border:1px solid #1b2127;border-radius:14px;padding:13px 15px;margin-bottom:14px}
.hl .lb{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;color:#8fb06a;margin-bottom:7px;letter-spacing:.04em}
.hl .lb span:last-child{color:#6b737e}
.recap{background:#101418;border:1px solid #1b2127;border-radius:14px;padding:13px 15px;margin-bottom:14px}
.recap .lb{font-size:11.5px;color:#7fa8c4;margin-bottom:7px;letter-spacing:.04em}
.sum h4,.recap h4,.hl h4{margin:12px 0 4px;font-size:13px;color:#dfe3e8;font-weight:640}
.sum h4:first-child,.recap h4:first-child,.hl h4:first-child{margin-top:2px}
.sum p,.recap p,.hl p{margin:0 0 6px;color:#b9bec5;font-size:13.5px}
.recap ul,.hl ul{margin:2px 0 8px;padding-left:18px;color:#b9bec5;font-size:13.5px}
.recap li,.hl li{margin:3px 0}
.recap blockquote,.hl blockquote{margin:6px 0;padding:2px 0 2px 10px;border-left:2px solid #2b343c;color:#98a1ab;font-size:13px}
.hl .k{color:#b9cf8e;font-size:12.5px;margin:5px 0 9px;white-space:pre-wrap;font-variant-numeric:tabular-nums}
.hl details,.recap details{margin-top:9px}
.hl summary,.recap summary{color:#8d9a76;font-size:12.5px;cursor:pointer}
.hl .ins{color:#c6cdd4;font-size:13.5px;line-height:1.75}
.hl .ins p{margin:0 0 6px}
.hl .hstat{display:flex;gap:10px;margin:12px 0 0}
.hl .hs{flex:1 1 0;min-width:0;background:#0d1210;border:1px solid #1e2a22;border-radius:12px;padding:10px 12px}
.hl .hs span{display:block;font-size:11px;color:#7d8b7a;letter-spacing:.04em}
.hl .hs b{display:block;font-size:19px;font-weight:660;color:#cfe6a8;font-variant-numeric:tabular-nums;line-height:1.35;margin-top:2px}
.hl .hs.burn b{color:#8fb6d6}
.hl .hs i{display:block;font-style:normal;font-size:11px;color:#6f7a72;margin-top:1px}
.hl .met{margin-top:10px;color:#98a1ab;font-size:12.5px}
.hl .hsect{margin-top:14px}
.hl .hsect h4{margin:0 0 7px;font-size:12px;color:#8fb06a;font-weight:640;letter-spacing:.04em}
.hl .rv{margin-bottom:10px}
.hl .rv b{display:block;font-size:12.5px;color:#dfe3e8;font-weight:640;margin-bottom:2px}
.hl .rv p{margin:0;color:#b9bec5;font-size:13px;line-height:1.7}
.hl .evs{display:flex;flex-direction:column}
.hl .ev{display:flex;gap:9px;align-items:baseline;padding:8px 0;border-top:1px solid #1a2320}
.hl .ev:first-child{border-top:0}
.hl .ev .et{flex:0 0 40px;color:#8fb06a;font-size:12px;font-variant-numeric:tabular-nums}
.hl .ev .ex{flex:1 1 auto;min-width:0;color:#b9bec5;font-size:12.5px;line-height:1.65}
.hl .ev .ek{flex:0 0 auto;font-size:11.5px;font-variant-numeric:tabular-nums;color:#6b737e}
.hl .ev .ek.up{color:#9fd08a}
.hl .ev .ek.dn{color:#7f97a8}
.hl .cal{margin-top:13px;background:#0d1210;border:1px solid #1e2a22;border-radius:12px;padding:10px 11px 8px}
.hl .clb{display:flex;justify-content:space-between;font-size:11px;color:#7d8b7a;letter-spacing:.04em;margin-bottom:4px}
.hl .cal svg{display:block;width:100%;height:108px;overflow:visible}
.hl .cax{display:flex;justify-content:space-between;font-size:10.5px;color:#6f7a72;margin-top:4px;font-variant-numeric:tabular-nums}
.hl .cax.cx{color:#5d6761;margin-top:2px}
.recap .rc{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 9px}
.recap .rc span{background:#151c22;border:1px solid #232b33;border-radius:6px;padding:2px 8px;font-size:11px;color:#8fa3b8}
.vid video{display:block;width:100%;height:auto;background:#000;aspect-ratio:9/16;max-height:62vh}
.vid .pl{position:relative}
.vid .play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.28);border:0;cursor:pointer}
.vid .play span{width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,.92);color:#0b0c0e;font-size:20px;display:flex;align-items:center;justify-content:center}
.vid .play[hidden]{display:none}
img.ph{display:block;width:100%;height:auto;background-color:#14171b;background-size:cover;background-position:center;background-repeat:no-repeat;transition:opacity .22s}
img.ph.lq{filter:blur(10px);transform:scale(1.03)}
.card img.ph{aspect-ratio:4/3}
.box img.ph{aspect-ratio:1/1}
img.ph.done{filter:none;transform:none;background-image:none;animation:none;background:#0f1115}
img.ph.done.ok{background:transparent}
img[data-full]{cursor:zoom-in}
#lb{position:fixed;inset:0;z-index:99;background:#07080a;display:flex;flex-direction:column}
#lb[hidden]{display:none}
.lbbar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px}
.lbbar button,.lbbar a{font:inherit;font-size:13px;line-height:1.2;color:#cfd6de;background:#191d22;border:1px solid #262c33;border-radius:10px;padding:8px 14px;text-decoration:none;cursor:pointer}
.lbbar a#lbsave{color:#141610;background:#ffca5f;border-color:#ffca5f;font-weight:660}
.lbbar a#lbsave.off{opacity:.4;pointer-events:none}
.lbstage{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 8px calc(16px + env(safe-area-inset-bottom));overflow:auto;-webkit-overflow-scrolling:touch}
.lbstage img{max-width:100%;max-height:100%;width:auto;height:auto;border-radius:8px;opacity:.35;transition:opacity .2s;background:#0d0f12;cursor:zoom-in}
.lbstage img.ok{opacity:1}
.lbstage.zoom{align-items:flex-start;justify-content:flex-start}
.lbstage.zoom img{max-width:none;max-height:none;cursor:zoom-out}
.lbhint{text-align:center;color:#5d646d;font-size:11.5px;padding:0 14px calc(10px + env(safe-area-inset-bottom))}
body.lblock{overflow:hidden;height:100dvh}
body.lblock footer{display:none}
#gate{display:none;max-width:360px;margin:14vh auto;padding:0 24px;text-align:center}
#gate.show{display:block}
#gate h1{font-size:16px;font-weight:600;margin:0 0 8px}
#gate .tip{color:var(--dim);font-size:12.5px;margin-bottom:12px}
#gate input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #262c35;background:var(--card);color:var(--tx);font-size:15px;margin:6px 0}
#gate button{width:100%;padding:12px;border-radius:10px;border:0;background:var(--tx);color:#0b0c0e;font-weight:640;font-size:15px;font-family:inherit}
#err{color:#e5847f;font-size:12.5px;min-height:18px;margin-top:6px}
.empty{text-align:center;color:#6b737e;padding:40px 0;font-size:13px}
.skel{height:3px;border-radius:2px;background:linear-gradient(90deg,#121417,#3b5b85 45%,#ffca5f 55%,#121417);background-size:220% 100%;animation:sh 1.1s linear infinite;margin:0 0 12px}
footer{text-align:center;color:#4e555e;font-size:11px;padding:4px 0 26px}
body.lock{overflow:hidden;height:100dvh}
body.lock footer{display:none}
body.lock main{padding-bottom:0;overflow:hidden;padding-left:5px;padding-right:10px}

.wk{display:flex;gap:8px;margin:0 0 14px}
.wk .w1{flex:1 1 0;min-width:0;background:linear-gradient(180deg,#131820 0%,#0f1319 100%);border:1px solid var(--line);border-radius:14px;padding:11px 12px}
.wk .w1 span{display:block;font-size:10.5px;color:#6f7883;letter-spacing:.06em;margin-bottom:3px}
.wk .w1 b{display:block;font-size:18px;font-weight:660;color:#e7ebf0;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.25}
.wk .w1 i{display:block;font-style:normal;font-size:10.5px;color:#66707b;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wk.only{display:block;background:linear-gradient(135deg,#141b24 0%,#0f1319 70%);border:1px solid var(--line);border-radius:16px;padding:14px 15px;margin-bottom:14px}
.wk .wh{font-size:11px;color:#7fa9e2;letter-spacing:.06em;margin-bottom:9px}
.wk .wg{display:flex;gap:14px}
.wk .wg div{min-width:0}
.wk .wg b{display:block;font-size:20px;font-weight:660;color:#e7ebf0;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.wk .wg span{display:block;font-size:10.5px;color:#6f7883;margin-top:1px}

/* ── v16 视觉打磨：更柔和的层次、更清晰的层级、更顺的点击反馈 ── */
:root{--bg:#0a0b0d;--card:#12151a;--card2:#0f1216;--line:rgba(255,255,255,.065);--line2:rgba(255,255,255,.10);--tx:#e9ebee;--dim:#7d848e;--acc:#6ea8fe}
body{-webkit-font-smoothing:antialiased;letter-spacing:.005em}
header{background:rgba(10,11,13,.86);border-bottom:1px solid var(--line);box-shadow:0 1px 0 rgba(255,255,255,.03)}
.hd1{padding:8px 14px 5px}
.hd1 b{font-size:14.5px;font-weight:660;letter-spacing:-.015em}
.hd1 span{font-size:10.5px;letter-spacing:.01em}
.chips{gap:7px;padding:0 14px 7px}
.chips button{border-radius:999px;padding:5px 11px;font-size:12px;border:1px solid var(--line2);color:#98a1ab;transition:background .16s,color .16s,border-color .16s}
.chips button:active{background:#1a1e24}
.chips button.on{background:rgba(110,168,254,.15);border-color:rgba(110,168,254,.45);color:#cfe2ff;font-weight:640}
main{padding:18px 16px 88px}
section.box,.card,.sum,.hl,.recap{border-radius:16px;border:1px solid var(--line);box-shadow:0 1px 0 rgba(255,255,255,.025) inset,0 12px 30px -24px rgba(0,0,0,.9)}
.card{margin-bottom:14px;transition:border-color .18s,transform .18s}
.card:active{transform:scale(.997)}
.box .lb{padding:10px 15px;font-size:11px;letter-spacing:.06em;color:#7d848e}
.box .bd{padding:13px 15px 15px}
.card .t{padding:12px 15px 0;font-size:11.5px;letter-spacing:.04em}
.card .t .dot{width:5px;height:5px;border-radius:50%;background:var(--acc);display:inline-block;margin-right:1px;opacity:.75;transform:translateY(-1px)}
.card .h{padding:5px 15px 0;font-size:16px;letter-spacing:-.012em;color:#eef0f3;line-height:1.45}
.card p{padding:0 15px;color:#b4bac2;line-height:1.78}
.card .loc{padding:0 15px}
.card .foot{padding:0 15px 14px}
.card .more{margin:8px 15px 0;color:#7fa9e2}
.del{opacity:.72;border-color:var(--line2);border-radius:999px;padding:6px 13px;transition:opacity .16s,background .16s,color .16s}
.del:hover,.del:active{opacity:1;color:#ffbdc9;border-color:#4a2630;background:#221419}
.tags span{border-radius:999px;padding:3px 9px;color:#8f97a1;background:#171b21;border:1px solid var(--line)}
.sum,.hl,.recap{background:linear-gradient(180deg,#111519 0%,#0e1115 100%)}
.sum .lb,.recap .lb,.hl .lb{font-size:11px;letter-spacing:.06em}
.hl .hs{border-radius:13px}
.hl .hs b{font-size:20px;letter-spacing:-.01em}
.hl .cal{border-radius:13px}
.sum .sx b{font-size:13.5px;letter-spacing:-.005em}
.vid video{border-radius:0}
.vid .play span{box-shadow:0 8px 24px -8px rgba(0,0,0,.8);backdrop-filter:blur(2px)}
.rail .rs{border-radius:999px}
/* 图片加载指示：低清底图之上转一个小圈，加载完自动消失 */
.iw{position:relative;display:block;line-height:0}
.iw .sp{position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
  border:2px solid rgba(255,255,255,.16);border-top-color:#cfe2ff;animation:spin .7s linear infinite}
.iw .sp.err{animation:none;border-color:#6b3a44;border-top-color:#ff9db0}
@keyframes spin{to{transform:rotate(360deg)}}
#lb .spin{position:absolute;left:50%;top:50%;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;
  border:2px solid rgba(255,255,255,.14);border-top-color:#cfe2ff;animation:spin .75s linear infinite;display:none}
#lb.busy .spin{display:block}
#lb.busy #lbimg{opacity:0}
#lbimg{transition:opacity .22s ease}
#lb.busy .lbhint{opacity:0}
.lbhint{transition:opacity .2s}

.rail .rs.on{box-shadow:0 0 0 4px rgba(110,168,254,.12),0 0 12px rgba(157,198,255,.35)}
.tlst button{padding:12px 2px;transition:background .14s}
.tlst .nm{letter-spacing:-.005em}
.moretabs button{border-radius:999px;padding:9px 6px;font-size:12.5px;transition:background .16s,color .16s}
.moretabs button.on{background:rgba(110,168,254,.15);border-color:rgba(110,168,254,.45);color:#cfe2ff;font-weight:640}
.tab{animation:tabin .2s ease both}
@keyframes tabin{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.empty{padding:44px 0;font-size:13px;color:#6b737e;letter-spacing:.01em}
.lbbar button,.lbbar a{border-radius:999px;font-size:12.5px;padding:8px 15px;transition:background .16s,opacity .16s}
.lbbar button:active,.lbbar a:active{background:#22272e}
#lb{background:#050607}
#gate{max-width:340px}
#gate h1{font-size:17px;letter-spacing:-.01em}
#gate input:focus{outline:none;border-color:rgba(110,168,254,.5);box-shadow:0 0 0 3px rgba(110,168,254,.10)}
#gate button{background:linear-gradient(180deg,#f3f5f8,#dfe3e8);color:#0a0b0d;font-weight:660;letter-spacing:.01em}
footer{color:#454b53;font-size:10.5px;letter-spacing:.02em}
/* v17 布局收口：内容不满一屏时页脚贴底，不留半屏空白 */
html{min-height:100%}
body{display:flex;flex-direction:column;min-height:100dvh}
body>header{flex:0 0 auto}
body>main{flex:1 1 auto;width:100%}
body>footer{flex:0 0 auto}
body.lock>main{flex:1 1 auto;min-height:0}
/* v18 封面 + 邀请口令 */
.cv{padding:4px 0 44px}
.cvhero{position:relative;border-radius:18px;overflow:hidden;border:1px solid var(--line2);background:linear-gradient(160deg,#151a22,#0b0d11 62%);margin-bottom:14px}
.cvhero .cvs{position:relative;aspect-ratio:4/3;background:#0d0f12}
.cvhero .csl{position:absolute;inset:0;opacity:0;transition:opacity .8s ease}
.cvhero .csl.on{opacity:1}
.cvhero .csl img{display:block;width:100%;height:100%;object-fit:contain;background:#0d0f12}
.cvhero .im,.cvhero>img{display:block;width:100%;height:auto;max-height:none;background:#0d0f12}
.cvhero .dots{position:absolute;right:14px;top:13px;display:flex;gap:5px;z-index:3}
.cvhero .dots i{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.34);transition:background .25s,transform .25s}
.cvhero .dots i.on{background:#fff;transform:scale(1.35)}
.cvhero .tx b em{font-style:normal;color:#9dc6ff}
.cvhero .veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(6,7,9,.10) 0%,rgba(6,7,9,.62) 52%,rgba(6,7,9,.95) 100%)}
.cvhero .tx{position:absolute;left:18px;right:18px;bottom:16px}
.cvhero .tx b{display:block;font-size:23px;line-height:1.25;letter-spacing:-.022em;color:#fff}
.cvhero .tx span{display:block;margin-top:7px;color:#a8b0bb;font-size:12.5px;line-height:1.62}
.cvhero .tx .k{display:inline-flex;gap:6px;align-items:center;margin-top:10px;font-size:11px;color:#8d96a1;letter-spacing:.02em}
.cvhero .tx .k u{width:5px;height:5px;border-radius:50%;background:var(--acc);text-decoration:none}
.cvstat{display:flex;gap:8px;margin-bottom:16px}
.cvstat div{flex:1 1 0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:11px 6px;text-align:center}
.cvstat b{display:block;font-size:18px;font-weight:660;letter-spacing:-.02em;color:#eef1f4;font-variant-numeric:tabular-nums}
.cvstat span{display:block;margin-top:3px;color:var(--dim);font-size:11px;letter-spacing:.01em}
.cvgo{display:block;width:100%;border:0;border-radius:14px;padding:14px;margin-bottom:18px;font-size:14.5px;font-weight:660;letter-spacing:.01em;color:#08111f;background:linear-gradient(180deg,#cfe2ff,#8fb8f2)}
.cvgo:active{transform:scale(.995)}
.cvsec{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 10px}
.cvsec b{font-size:13px;font-weight:640;color:#dfe4ea;letter-spacing:-.005em}
.cvsec span{font-size:11.5px;color:#6f7781}
.cvd{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:8px;color:var(--tx);transition:transform .12s,background .15s,border-color .15s}
.cvd:active{transform:scale(.994);background:#171b21;border-color:rgba(110,168,254,.34)}
.cvd.off{opacity:.42}
.cvd.off:active{transform:none;background:var(--card);border-color:var(--line)}
.cvd .dt{flex:0 0 58px}
.cvd .dt b{display:block;font-size:14.5px;font-weight:660;letter-spacing:-.012em;color:#eef1f4}
.cvd .dt i{display:block;font-style:normal;color:var(--dim);font-size:11px;margin-top:2px}
.cvd .ds{flex:1 1 auto;min-width:0;color:#98a1ab;font-size:11.5px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cvd .dn{flex:0 0 auto;color:#7f9dc6;font-size:11.5px;font-variant-numeric:tabular-nums}
.cvd .ar{flex:0 0 auto;color:#4a515b;font-size:15px;line-height:1}
.cvinv{display:block;width:100%;margin-top:6px;border:1px dashed #2b3138;border-radius:14px;padding:13px;background:transparent;color:#9aa3ae;font-size:13px;letter-spacing:.01em}
.cvinv:active{background:#14181d;border-color:rgba(110,168,254,.4)}
.inv{padding:2px 0 44px}
.inv .top{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.inv .top button{flex:0 0 auto;border-radius:999px;padding:7px 14px;font-size:12.5px}
.inv .top b{font-size:16px;letter-spacing:-.015em;color:#eef1f4}
.inv .new{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:16px}
.inv .new label{display:block;font-size:11.5px;color:var(--dim);margin:0 0 6px;letter-spacing:.02em}
.inv .new input{width:100%;background:#0c0f13;border:1px solid #22272e;border-radius:11px;padding:10px 12px;color:var(--tx);font-size:13.5px;margin-bottom:12px}
.inv .new input:focus{outline:none;border-color:rgba(110,168,254,.5);box-shadow:0 0 0 3px rgba(110,168,254,.10)}
.inv .durs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.inv .durs button{border-radius:999px;padding:6px 13px;font-size:12px;background:transparent;border:1px solid #24282e;color:#98a1ab}
.inv .durs button.on{background:rgba(110,168,254,.15);border-color:rgba(110,168,254,.45);color:#cfe2ff;font-weight:640}
.inv .new .go{width:100%;border:0;border-radius:12px;padding:12px;font-size:13.5px;font-weight:660;color:#08111f;background:linear-gradient(180deg,#cfe2ff,#8fb8f2)}
.inv .it{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 14px;margin-bottom:9px}
.inv .it .r1{display:flex;align-items:center;gap:10px}
.inv .it code{flex:1 1 auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;color:#e8eef7;word-break:break-all}
.inv .it .r1 b{flex:0 0 auto;font-size:11px;font-weight:600;color:#7ee0a8;background:rgba(126,224,168,.10);border:1px solid rgba(126,224,168,.24);border-radius:999px;padding:2px 9px}
.inv .it .r1 b.off{color:#8a919b;background:rgba(255,255,255,.04);border-color:#2a2f36}
.inv .it .r2{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:9px;color:#7f8792;font-size:11.5px}
.inv .surl{background:linear-gradient(180deg,#131922,#0f1319);border:1px solid var(--line2);border-radius:14px;padding:12px 13px;margin-bottom:12px}
.inv .surl label{display:block;font-size:11px;color:#7f8894;letter-spacing:.05em;margin-bottom:6px}
.inv .surl code{display:block;font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#a9c7f0;word-break:break-all;margin-bottom:10px}
.inv .surl .row{display:flex;gap:7px}
.inv .surl .row button{flex:1 1 0;padding:8px 0;border-radius:10px;border:1px solid rgba(110,168,254,.38);background:rgba(110,168,254,.13);color:#cfe2ff;font-size:12px;font-family:inherit;cursor:pointer}
.inv .it .r2 span{flex:0 0 auto;white-space:nowrap}
.inv .it .r2 .sp{flex:1 1 auto}
.inv .it .r2 button{flex:0 0 auto;white-space:nowrap;border-radius:999px;padding:5px 9px;font-size:11px;background:transparent;border:1px solid #262b32;color:#9aa3ae}
.inv .it .r2{margin-top:9px;gap:5px;color:#7f8792;font-size:11px}
.inv .it .r2 span:first-child{flex:0 0 auto}
.inv .it .r2 button.dg{color:#ffbdc9;border-color:#4a2630}
.inv .hint{color:#6b737e;font-size:11.5px;line-height:1.7;margin-top:4px}
.inv .none{color:#6b737e;font-size:12.5px;padding:18px 2px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

function htmlPage({ ct, days, day, title, builtAt, have }) {
  const haveSet = new Set(have || days);
  const dayList = JSON.stringify(days.map(d => ({ d, w: wdOf(d), has: haveSet.has(d) })));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0b0c0e"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230b0c0e'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%236ea8fe'/%3E%3C/svg%3E">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header>
<div class="hd1"><div class="hdc"><button id="covbtn" hidden>‹</button><b id="dayname">${esc(title)}</b></div><div class="hdr"><span id="upd">更新于 ${esc(builtAt)}</span><button id="rfb" title="立即抓取最新内容" aria-label="刷新">↻</button></div></div>
<div id="rfn" hidden><i></i><span id="rfnt">正在更新…</span></div>
<div class="chips days7" id="days"></div>
<div class="chips" id="tabs" hidden></div>
</header>
<div id="gate"><h1>需要口令</h1><div class="tip">输入口令，或朋友给你的邀请码</div><input id="pw" type="text" placeholder="口令 / 邀请码" autocomplete="off" autocapitalize="characters" inputmode="text"><button id="go">进入</button><div id="err"></div></div>
<main id="app" hidden></main>
<footer>内容只在你的设备上解密</footer>
<div id="lb" hidden>
<div class="lbbar"><button id="lbx">关闭</button><a id="lbsave" class="off" download>保存到本地</a></div>
<div class="lbstage" id="lbstage"><b class="spin"></b><img id="lbimg" alt=""></div>
<div class="lbhint">点图可看原始尺寸 · 手机上也可长按图片保存</div>
</div>
<div id="rfo" hidden><b class="sp2"></b><b id="rfm">正在刷新…</b><span id="rfs">正在从 Looki 抓取最新内容</span></div>
<script>
var E=${JSON.stringify(ct)};
var RF=${JSON.stringify(RF_TOPIC)};
var P={day:${JSON.stringify(day)},days:${dayList}};
var ITER=${ITER};
var $=function(i){return document.getElementById(i)};
var BASE=(function(){var u=new URL(location.href);u.hash="";u.search="";var p=u.pathname;
  p=p.indexOf("/d/")>=0?p.replace(/\\/d\\/[^/]*$/,"/"):p.replace(/[^/]*$/,"");
  u.pathname=p;return u.href;})();
var SALT8=U8(E.salt), KEYS={}, RAWKEY=null;
// 口令 → PBKDF2 原始密钥只推导一次，再按 salt 派生 AES key 并缓存：手机上不用每张图跑一遍 60 万轮
function mkRaw(p){return crypto.subtle.importKey("raw",new TextEncoder().encode(p),"PBKDF2",false,["deriveKey"])}
function rawKey(){
  if(!RAWKEY)RAWKEY=mkRaw(PASS);
  return RAWKEY;
}
function keyFor(salt){
  var k=KEYS[salt];
  if(!k)k=KEYS[salt]=rawKey().then(function(km){
    return crypto.subtle.deriveKey({name:"PBKDF2",salt:U8(salt),iterations:ITER,hash:"SHA-256"},km,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);});
  return k;
}
function resetKeys(){RAWKEY=null;KEYS={}}
function dec(iv,u8,salt){return keyFor(salt||E.salt).then(function(k){return crypto.subtle.decrypt({name:"AES-GCM",iv:iv,tagLength:128},k,u8)})}
function page(pass,E2){
  PASS=PASS||pass;
  return dec(U8(E2.iv),U8(E2.ct),E2.salt).then(function(b){return JSON.parse(new TextDecoder().decode(b))});
}
function U8(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)})}
var PASS=null,CACHE={},BLOB={};
var TABS=[["hl","精彩"],["segs","片段"],["time","时段"],["more","记录"]];
function ago(ms){
  var m=Math.round(ms/60000);
  if(m<2)return "刚刚";
  if(m<60)return m+" 分钟前";
  if(m<1440)return Math.floor(m/60)+" 小时前";
  return Math.floor(m/1440)+" 天前";
}
function pad(n){return ("0"+n).slice(-2)}
function dur(mins){return mins>=60?Math.floor(mins/60)+" 小时"+(mins%60?" "+mins%60+" 分":""):mins+" 分钟"}

function chips(){
  var h="";
  P.days.forEach(function(o){
    var off=o.has===false;
    h+='<button data-day="'+o.d+'"'+(off?' class="off" disabled':(o.d===P.day&&INVIEW==="day"?' class="on"':''))+'>'+
       '<b>'+o.d.slice(5).replace("-","/")+'</b><span>'+o.w+'</span></button>';
  });
  var el=$("days");
  if(!el.__bound){el.__bound=true;el.addEventListener("click",function(e){
    var b=e.target.closest("button[data-day]"); if(b&&!b.disabled)openDay(b.dataset.day);});}
  el.style.setProperty("--dn",P.days.length);
  el.innerHTML=h;
  var cb=$("covbtn");
  if(cb){
    if(!cb.__bound){cb.__bound=true;cb.onclick=function(){showCover()}}
    cb.hidden=!(COVERD&&INVIEW!=="cover");
  }
}

/* ---------- 封面视图 ---------- */
var CV=null, INVIEW="day", VIEWDAY="", COVERD=null, CURTAB="";

function coverHtml(c){
  var sl=(c.slides&&c.slides.length?c.slides:(c.hero?[{rel:c.hero,lq:c.heroLq}]:[])).filter(function(x){return x&&x.rel});
  var hero="";
  if(sl.length){
    hero='<div class="cvs">'+sl.map(function(o,i){
      return '<div class="csl'+(i===0?" on":"")+'" data-i="'+i+'"><img alt="" data-cv="'+escHtml(o.rel)+'" data-lq="'+
        (o.lq?escHtml(o.lq):"")+'"></div>';
    }).join("")+'</div>';
    if(sl.length>1)hero+='<div class="dots">'+sl.map(function(o,i){return '<i'+(i===0?' class="on"':'')+'></i>'}).join("")+'</div>';
  }
  var st=[];
  st.push('<div><b>'+c.days+"</b><span>天有记录</span></div>");
  st.push('<div><b>'+c.segs+"</b><span>段片段</span></div>");
  st.push('<div><b>'+c.hours+"</b><span>小时</span></div>");
  var h='<div class="cv">';
  h+='<div class="cvhero">'+hero+'<div class="veil"></div><div class="tx"><b>'+escHtml(c.title)+'</b>'+
     '<span>'+escHtml(c.sub)+'</span><div class="k"><u></u>'+escHtml(c.kind)+'</div></div></div>';
  h+='<div class="cvstat">'+st.join("")+'</div>';
  h+='<button class="cvgo" data-today="1">进入今天 · '+escHtml(c.today)+'</button>';
  h+='<div class="cvsec"><b>最近 '+c.win+' 天</b><span>点哪天看哪天</span></div>';
  c.list.forEach(function(o){
    var empty=!o.n;
    h+='<button class="cvd'+(empty?" off":"")+'"'+(empty?' disabled':' data-day="'+o.d+'"')+'>'+
       '<div class="dt"><b>'+o.md+'</b><i>'+o.w+'</i></div>'+
       '<div class="ds">'+escHtml(o.sub)+'</div><div class="dn">'+(empty?"":o.n+" 段")+'</div>'+
       '<div class="ar">'+(empty?"":"›")+'</div></button>';
  });
  if(OWN)h+='<button class="cvinv" data-inv="1">申请一个口令，发给朋友 ›</button>';
  h+='<p class="hint" style="color:#6b737e;font-size:11.5px;line-height:1.7;margin-top:12px">这个页面只是你自己的记录，别人打开需要口令。</p>';
  h+='</div>';
  return h;
}
var CVT=null, CVI=0, CVMISS={};
function cvStop(){ if(CVT){clearInterval(CVT);CVT=null} }
function cvStep(){
  var box=$("app").querySelector(".cvs"); if(!box)return cvStop();
  var ls=box.querySelectorAll(".csl"); if(ls.length<2)return cvStop();
  CVI=(CVI+1)%ls.length;
  for(var i=0;i<ls.length;i++)ls[i].classList.toggle("on",i===CVI);
  var ds=$("app").querySelectorAll(".cvhero .dots i");
  for(var j=0;j<ds.length;j++)ds[j].classList.toggle("on",j===CVI);
  cvLoad(CVI);
}
function cvLoad(i){
  var box=$("app").querySelector(".cvs"); if(!box)return;
  var d=box.querySelector('.csl[data-i="'+i+'"]'); if(!d)return;
  var im=d.querySelector("img"); if(!im||im.__ok||CVMISS[im.dataset.cv])return;
  if(im.dataset.lq&&!im.__lq){ im.__lq=1; im.style.backgroundImage="url("+im.dataset.lq+")"; im.style.backgroundSize="cover"; im.style.backgroundPosition="center"; }
  var rel=im.dataset.cv;
  bin(rel).then(function(o){ im.src=o; im.__ok=1; }).catch(function(){ CVMISS[rel]=1; });
}
function cvRun(){
  cvStop();
  var box=$("app").querySelector(".cvs"); if(!box)return;
  var n=box.querySelectorAll(".csl").length;
  for(var i=0;i<n;i++)cvLoad(i);          // 全部预取（都是缩略图，几十 KB）
  CVI=0;
  if(n>1)CVT=setInterval(cvStep,1600);    // 每 1.6 秒切一张
}
function showCover(){
  if(!COVERD)return false;
  cvStop();
  CV=COVERD; INVIEW="cover"; VIEWDAY="";
  $("dayname").textContent="Looki 记录";
  var u=$("upd"); if(u){u.textContent=""; u.className=""}
  $("tabs").hidden=true; $("tabs").innerHTML="";
  $("days").hidden=true;
  chips();
  $("app").innerHTML=coverHtml(CV);
  $("app").onclick=function(e){
    var t=e.target.closest("[data-day],[data-today],[data-inv]"); if(!t)return;
    if(t.dataset.inv){openInv();return}
    if(t.hasAttribute("data-today")){var td=P.days[0]&&P.days[0].d; openDay(td);return}
    openDay(t.dataset.day);
  };
  $("gate").classList.remove("show"); $("app").hidden=false;
  document.body.classList.remove("lock"); document.body.classList.remove("lblock");
  window.scrollTo(0,0);
  cvRun();
  return true;
}
function openDay(day){
  if(!day)return;
  cvStop();
  INVIEW="day"; VIEWDAY=day;
  if(!window.__D||day!==window.__D.date){switchDay(day);return}
  render(window.__D);
}
function escHtml(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}

/* ---------- 动态口令（邀请码） ---------- */
var OWN=false;
var INV_API="https://api.restful-api.dev/objects/ff808181a09d98f701a21103d8754278";
var INV=null, INVPEND=null;
var INV_LS="inv1";

function invLocal(){ try{var o=JSON.parse(localStorage.getItem(INV_LS)||"null"); return Array.isArray(o)?o:[]}catch(e){return []} }
function invLocalSave(list){ try{localStorage.setItem(INV_LS,JSON.stringify(list||[]))}catch(e){} }
var INV_TS="invts", INV_IVL=12*3600000;
// 云端那个免费接口每天只有 50 次额度：本机先缓存 12 小时，额度留给「新口令」和「管理面板」。
function mergeInv(a,b){            // 按 id 并集，b 覆盖 a 的同 id 项
  var m={},out=[];
  (a||[]).concat(b||[]).forEach(function(x){ if(x&&x.id)m[x.id]=x });
  for(var k in m)out.push(m[k]);
  return out;
}
function invLoad(force){
  var local=invLocal(), ts=0;
  try{ts=+(localStorage.getItem(INV_TS)||0)}catch(e){}
  if(!force && local.length && Date.now()-ts<INV_IVL){ INV=local; return Promise.resolve(INV); }
  if(INVPEND)return INVPEND;
  INVPEND=fetch(INV_API,{cache:"no-store",signal:(typeof AbortSignal!=="undefined"&&AbortSignal.timeout)?AbortSignal.timeout(6000):undefined}).then(function(r){return r.ok?r.json():null}).then(function(j){
    var it=(j&&j.data&&Array.isArray(j.data.items))?j.data.items:null;
    // 用「本机 + 云端」的并集，绝不能用云端那份直接盖掉本机的：
    // 云端可能是几分钟前的快照，盖掉就把刚生成的口令弄没了。
    var now=invLocal();
    INV = it ? mergeInv(it, now) : now;
    invLocalSave(INV);
    if(it)try{localStorage.setItem(INV_TS,String(Date.now()))}catch(e){}
    INVPEND=null; return INV;
  }).catch(function(){ INVPEND=null; INV=invLocal(); return INV; });
  return INVPEND;
}
var INVPUT=null;
function invSave(list){
  INV=list; invLocalSave(list); try{localStorage.setItem(INV_TS,String(Date.now()))}catch(e){}
  // 串行化写入：两处同时改了列表时，后一次 PUT 必须带上前一次的结果，
  // 否则先发的那个请求会把后发的覆盖回去（删掉的口令又回来）。
  var send=function(){
    return fetch(INV_API,{method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({name:"looki-today-invites",data:{v:1,items:INV||[]}})})
      .then(function(r){return r.ok}).catch(function(){return false});
  };
  INVPUT = (INVPUT||Promise.resolve(true)).then(send,send);
  return INVPUT;
}
function rndCode(){
  var A="ABCDEFGHJKLMNPQRSTUVWXYZ23456789",s="";
  var b=new Uint8Array(12); crypto.getRandomValues(b);
  for(var i=0;i<12;i++)s+=A[b[i]%A.length];
  return s.slice(0,4)+"-"+s.slice(4,8)+"-"+s.slice(8,12);
}
function b64(u8){var s="";for(var i=0;i<u8.length;i++)s+=String.fromCharCode(u8[i]);return btoa(s)}
function invEnc(code,plain){
  var salt=E.salt, iv=new Uint8Array(12); crypto.getRandomValues(iv);
  return mkRaw(code).then(function(km){
    return crypto.subtle.deriveKey({name:"PBKDF2",salt:U8(salt),iterations:ITER,hash:"SHA-256"},km,{name:"AES-GCM",length:256},false,["encrypt"]);
  }).then(function(k){
    return crypto.subtle.encrypt({name:"AES-GCM",iv:iv},k,new TextEncoder().encode(plain));
  }).then(function(ct){
    return b64(iv)+"."+b64(new Uint8Array(ct));
  });
}
function invDec(code,blob){
  var parts=String(blob||"").split("."); if(parts.length!==2)return Promise.reject(new Error("bad blob"));
  var salt=E.salt;
  return mkRaw(code).then(function(km){
    return crypto.subtle.deriveKey({name:"PBKDF2",salt:U8(salt),iterations:ITER,hash:"SHA-256"},km,{name:"AES-GCM",length:256},false,["decrypt"]);
  }).then(function(k){
    return crypto.subtle.decrypt({name:"AES-GCM",iv:U8(parts[0]),tagLength:128},k,U8(parts[1]));
  }).then(function(b){return new TextDecoder().decode(b)});
}
function daysLeft(exp){ return Math.max(0,Math.ceil((exp-Date.now())/86400000)) }
function invAlive(it){ return !it.exp || it.exp>Date.now() }

function shareUrl(){ return BASE }
function invMsg(code,exp){
  var d=exp?Math.max(1,Math.ceil((exp-Date.now())/86400000)):0;
  return "快来看看我的 Looki 记录 👉 "+shareUrl()+"\\n口令："+code+(d?"（"+d+" 天后失效）":"（长期有效）");
}
function invHtml(){
  var list=(INV||[]).slice().sort(function(a,b){return (b.created||0)-(a.created||0)});
  var h='<div class="inv"><div class="top"><button id="invback">‹ 返回</button><b>口令管理</b></div>';
  h+='<div class="surl"><label>分享链接</label><code>'+escHtml(shareUrl())+'</code>'
    +'<div class="row"><button data-lcopy="1">复制链接</button><button data-lcopy="2">复制链接 + 说明</button></div></div>';
  h+='<div class="new"><label>有效期</label><div class="durs">'+
     '<button data-dd="1">1 天</button><button data-dd="3" class="on">3 天</button>'+
     '<button data-dd="7">7 天</button><button data-dd="30">30 天</button>'+
     '<button data-dd="0">永久</button></div>'+
     '<button class="go" id="invnew">生成一个口令</button></div>';
  h+='<div class="cvsec"><b>已有的口令</b><span>'+list.filter(invAlive).length+' 个有效</span></div>';
  if(!list.length)h+='<p class="none">还没有口令。上面选一个有效期，点「生成」就行。</p>';
  list.forEach(function(it){
    var al=invAlive(it);
    h+='<div class="it" data-id="'+escHtml(it.id)+'"><div class="r1"><code>'+escHtml(it.code)+'</code>'+
       '<b class="'+(al?"":"off")+'">'+(al?(it.exp?"剩 "+daysLeft(it.exp)+" 天":"永久"):"已过期")+'</b></div>'+
       '<div class="r2"><span>创建 '+escHtml(new Date(it.created||Date.now()).toLocaleDateString("zh-CN"))+'</span><span class="sp"></span>'+
       '<button data-ext="7">+7 天</button><button data-ext="30">+30 天</button>'+
       '<button data-copy="'+escHtml(it.code)+'" data-exp="'+(it.exp||0)+'">复制邀请</button>'+
       '<button class="dg" data-del="'+escHtml(it.id)+'">删除</button></div></div>';
  });
  h+='<p class="hint">拿到口令的人可以打开这个页面，看到全部内容。到期后自动失效。口令是存在云端的，换台手机也能用。</p></div>';
  return h;
}
function openInv(){
  INVIEW="inv";
  $("days").hidden=true;
  $("tabs").hidden=true;
  INV=invLocal();                       // 先用本机那份立刻画出来，云端慢也不挡
  $("app").innerHTML=invHtml(); openInvBind();
  invLoad(true).then(function(){        // 后台跟云端对一次，回来了再刷新（不显示"读取中"）
    if(INVIEW!=="inv")return;
    $("app").innerHTML=invHtml(); openInvBind();
  }).catch(function(){});
}
function openInvBind(){
  var back=$("invback"); if(back)back.onclick=function(){ if(COVERD)showCover(); else render(window.__D) };
  var dd=3;
  document.querySelectorAll(".inv .durs button").forEach(function(b){b.onclick=function(){
    document.querySelectorAll(".inv .durs button").forEach(function(x){x.classList.toggle("on",x===b)});
    dd=+b.dataset.dd;};});
  var nw=$("invnew");
  if(nw)nw.onclick=function(){
    var btn=nw; btn.disabled=true; btn.textContent="生成中…";
    var code=rndCode(), exp=dd?Date.now()+dd*86400000:0;
    invEnc(code,PASS).then(function(blob){
      var it={id:Date.now().toString(36)+Math.random().toString(36).slice(2,7),code:code,blob:blob,exp:exp,created:Date.now()};
      var cur=mergeInv(INV,[]); cur.push(it);
      // 先落本地、立刻画出来：云端那一次 PUT 可能要等好几秒，
      // 甚至因为额度用完一直挂着 —— 不能让「生成口令」卡在网络上。
      INV=cur; invLocalSave(cur);
      $("app").innerHTML=invHtml(); openInvBind();
      toast("口令已生成，点「复制邀请」发给朋友");
      invSave(cur).then(function(ok){
        if(!ok)toast("已存在本机，云端暂时没同步上（不影响使用）");
      });
    }).catch(function(e){ btn.disabled=false; btn.textContent="生成一个口令"; toast("生成失败"); console.warn(e) });
  };
  document.querySelectorAll(".inv [data-ext]").forEach(function(b){b.onclick=function(){
    var box=b.closest(".it"), id=box.dataset.id, add=+b.dataset.ext;
    var cur=(INV||[]).map(function(x){
      if(x.id!==id)return x;
      var base=Math.max(Date.now(),x.exp||Date.now());
      var y={}; for(var k in x)y[k]=x[k]; y.exp=base+add*86400000; return y;
    });
    INV=cur; invLocalSave(cur); $("app").innerHTML=invHtml(); openInvBind(); toast("有效期已延长");
    invSave(cur);   // 云端后台同步，不挡界面
  }});
  document.querySelectorAll(".inv [data-del]").forEach(function(b){b.onclick=function(){
    var id=b.dataset.del;
    var cur=(INV||[]).filter(function(x){return x.id!==id});
    INV=cur; invLocalSave(cur); $("app").innerHTML=invHtml(); openInvBind(); toast("已删除这个口令");
    invSave(cur);   // 云端后台同步，不挡界面
  }});
  document.querySelectorAll(".inv [data-copy]").forEach(function(b){b.onclick=function(){
    copyText(invMsg(b.dataset.copy,+b.dataset.exp||0),function(ok){
      toast(ok?"邀请文案已复制，直接发给朋友":"复制不了，手动抄一下："+b.dataset.copy);
    });
  }});
  document.querySelectorAll(".inv [data-lcopy]").forEach(function(b){b.onclick=function(){
    var t=b.dataset.lcopy==="1"?shareUrl():("这是我的 Looki 记录，用口令打开 👉 "+shareUrl());
    copyText(t,function(ok){ toast(ok?"链接已复制":"复制不了，手动抄一下："+shareUrl()) });
  }});
}
function copyText(t,cb){
  var done=function(ok){ if(cb)cb(ok) };
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(function(){done(true)},function(){done(fbCopy(t))});
      return;
    }
  }catch(e){}
  done(fbCopy(t));
}
function fbCopy(t){
  try{
    var ta=document.createElement("textarea"); ta.value=t;
    ta.style.cssText="position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0,t.length);
    var ok=document.execCommand("copy"); ta.remove(); return ok;
  }catch(e){ return false }
}
function tryInvite(code){
  return invLoad(false).then(function(list){
    var it=(list||[]).filter(function(x){return x.code===code})[0];
    if(!it)throw new Error("no such invite");
    if(it.exp&&it.exp<=Date.now())throw new Error("expired");
    return invDec(code,it.blob);
  });
}

// 图片懒加载：先解密首屏，其余滚到再取（手机上原来是一次性并发 15 张，卡成一片空白）
var IO=null, Q=[], RUN=0, LIMIT=3, NEAR=null, NEART=null;
function pic(v,cls,lq,w,h,full){
  if(!v)return "";
  if(v.indexOf("data:")===0)return '<img src="'+v+'" alt="">';
  var id=cls||("p"+Math.random().toString(36).slice(2,9));
  setTimeout(function(){watch(id,v)},0);
  var st="";
  if(w&&h)st+="aspect-ratio:"+w+"/"+h+";";
  if(lq)st+="background-image:url('"+lq+"');";
  // data-full：点开才去下高清那张（列表只吃缩略图的流量）
  var da=full?' data-full="'+full+'"':'';
  return '<span class="iw"><img id="'+id+'" class="'+((w&&h||lq)?'ph lq':'ph')+'" style="'+st+'"'+da+' alt="">'+
         '<b class="sp" style="'+(w&&h?"":"display:none")+'"></b></span>';
}

// 点图 → 全屏看高清 + 可保存到本地；高清字节只有点了才下
var LB=null, LBSAVE=null;
function lbClose(){
  var w=$("lb"); if(w){w.hidden=true;w.classList.remove("busy")}
  var im=$("lbimg"); if(im){im.removeAttribute("src");im.classList.remove("ok")}
  var a=$("lbsave"); if(a){a.className="off";a.removeAttribute("href")}
  var stg=$("lbstage"); if(stg)stg.className="lbstage";
  LB=null; LBSAVE=null;
  document.body.classList.remove("lblock");
}
function lbOpen(rel){
  if(!rel)return;
  LB=rel;
  var w=$("lb"), im=$("lbimg"), a=$("lbsave");
  if(!w||!im||!a)return;
  w.hidden=false; w.classList.remove("busy"); document.body.classList.add("lblock");
  a.className="off"; a.removeAttribute("href");
  im.classList.remove("ok");
  if(BLOB[rel]){ w.classList.remove("busy"); im.src=BLOB[rel]; im.classList.add("ok"); lbArm(rel); return; }
  w.classList.add("busy");                       // 黑屏那一瞬改成转圈，别让人以为卡死
  bin(rel).then(function(o){ if(LB!==rel)return; w.classList.remove("busy"); im.src=o; im.classList.add("ok"); lbArm(rel); })
    .catch(function(e){ w.classList.remove("busy");
      // 只到这一步说明真取不到：把原因说清楚，并留一句可操作的话
      var st=(e&&e.message)||"";
      toast(/^404/.test(st)?"这张高清图没了，换一张试试":(/^(403|cdn )/.test(st)?"网络不太好，再点一次试试":"加载失败，再点一次试试"));
      console.warn("lb",rel,e); });
}
function lbArm(rel){
  var a=$("lbsave"), b=BLOB[rel];
  if(!a||!b)return;
  LBSAVE=b;
  a.href=b;
  a.download="looki-"+(P.day||"img")+"-"+String(rel).split("/").pop();
  a.className="";
}
function lbClick(e){
  var im=e.target.closest?e.target.closest("img[data-full]"):null;
  if(!im)return;
  e.preventDefault();
  lbOpen(im.getAttribute("data-full"));
}
function watch(id,v){
  var el=$(id); if(!el)return;
  var job={id:id,v:v};
  if(id==="jrn"){Q.unshift(job);pump();return}
  if(!IO){
    var rt=el.closest?el.closest(".sc"):null;      // 片段页的滚动发生在 #sc 里，root 必须是它
    IO=new IntersectionObserver(function(es){
      es.forEach(function(e){
        if(!e.isIntersecting)return;
        var j=e.target.__job; if(!j)return;
        IO.unobserve(e.target); e.target.__job=null; Q.push(j); pump();
      });
    },{root:rt||null,rootMargin:"600px 0px"});
    NEAR=rt;
  }
  el.__job=job;
  if(Q.length<1&&RUN<LIMIT){} 
  IO.observe(el);
}
function pumpNear(){
  if(!IO)return;
  var sc=$("sc")||null;
  var top=sc?sc.getBoundingClientRect().top:0;
  var hgt=sc?sc.clientHeight:window.innerHeight;
  var imgs=$("app").querySelectorAll("img.ph");
  for(var i=0;i<imgs.length;i++){
    var el=imgs[i]; var j=el.__job; if(!j)continue;
    var r=el.getBoundingClientRect();
    if(r.bottom>top-900&&r.top<top+hgt+900){ IO.unobserve(el); el.__job=null; Q.push(j); }
  }
  pump();
}
function pump(){
  while(RUN<LIMIT&&Q.length){
    var j=Q.shift(); RUN++;
    (function(job){
      bin(job.v).then(function(o){var el=$(job.id);if(el){el.src=o;el.classList.add("done");
        var sp=el.nextElementSibling; if(sp&&sp.className==="sp")sp.remove();
        if(el.complete)el.classList.add("ok");else el.onload=function(){el.classList.add("ok")}}})
        .catch(function(e){console.warn("img",e);var el=$(job.id);var sp=el&&el.nextElementSibling;
          if(sp&&sp.className==="sp")sp.classList.add("err")})
        .then(function(){RUN--;pump()});
    })(j);
  }
}
function mime(b){
  var u=new Uint8Array(b);
  if(u.length>12&&u[0]===82&&u[8]===87)return "image/webp";
  if(u.length>12&&u[4]===102&&u[5]===116&&u[6]===121&&u[7]===112)return "video/mp4";
  if(u.length>4&&u[0]===255&&u[1]===216)return "image/jpeg";
  if(u.length>8&&u[0]===137&&u[1]===80)return "image/png";
  return "application/octet-stream";
}
var CDN="https://gcore.jsdelivr.net/gh/2130391838/looki-today@main/";
var HIDE_API="https://api.restful-api.dev/objects/ff808181a09d98f701a20cb3614631b6";
var HIDE=null, HPEND=null;
function H(k){return !!(HIDE&&HIDE[k])}
// 删除记录以本机 localStorage 为准（云端那个免费接口每天只有 50 次额度，
// 一旦超额就会把删掉的内容全部放回来），云端只做尽力而为的同步。
var HIDE_LS="hid2";
function hideLocal(){
  try{var a=JSON.parse(localStorage.getItem(HIDE_LS)||"[]"),m={};
    for(var i=0;i<a.length;i++)m[a[i]]=1; return m;
  }catch(e){return {}}
}
function hideLocalSave(){
  try{localStorage.setItem(HIDE_LS,JSON.stringify(Object.keys(HIDE||{})))}catch(e){}
}
var HIDE_TS="hidts", HIDE_IVL=6*3600000;
function hideLoad(){
  if(HPEND)return HPEND;
  HIDE=hideLocal();
  var ts=0; try{ts=+(localStorage.getItem(HIDE_TS)||0)}catch(e){}
  if(Date.now()-ts<HIDE_IVL)return Promise.resolve(HIDE);   // 6 小时内不重复打扰云端
  // 后台顺带跟云端并一下（失败完全不影响本地删除结果）
  var sig=null;
  try{ if(typeof AbortSignal!=="undefined"&&AbortSignal.timeout) sig=AbortSignal.timeout(5000) }catch(e){}
  HPEND=fetch(HIDE_API,{cache:"no-store",signal:sig||undefined}).then(function(r){return r.ok?r.json():null}).then(function(j){
    var arr=(j&&j.data&&j.data.h)||[];
    if(arr.length){
      for(var i=0;i<arr.length;i++)HIDE[arr[i]]=1;
      hideLocalSave();
    }
    try{localStorage.setItem(HIDE_TS,String(Date.now()))}catch(e){}
    return HIDE;
  }).catch(function(){return HIDE});
  HPEND.then(function(){HPEND=null},function(){HPEND=null});   // 失败也别把下次卡住
  return HPEND;
}
function hideSave(){
  hideLocalSave();
  try{localStorage.setItem(HIDE_TS,String(Date.now()))}catch(e){}
  return fetch(HIDE_API,{method:"PUT",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({name:"looki-today-hidden",data:{h:Object.keys(HIDE||{})}})})
    .then(function(r){return true}).catch(function(){return true});
}
function hideAdd(k){
  if(!OWN){ toast("只有主入口（带密钥的链接）才能删除"); return Promise.resolve(true) }  // 访客：只读
  HIDE=hideLocal(); HIDE[k]=1; hideLocalSave();
  return hideSave().then(function(){toast("已删除");render(window.__D)});
}
function cdnUrl(url){
  var q=url.split("?")[0];
  if(q.slice(-4)!==".mp4")return null;
  var i=url.indexOf("m/"); if(i<0)return null;
  return CDN+url.slice(i);
}
function fetchAll(url,onP){
  // 有一次带 ?r= 的重试：CDN 边缘偶尔会缓存住一次 404，绕过缓存就好了；
  // 没有这层，用户点开一张刚生成的图会撞上「高清图加载失败」。
  return fetchOnce(url,onP).catch(function(e){
    if(!/^(404|403|cdn )/.test(String(e&&e.message)))throw e;
    return fetchOnce(url+"?r="+Date.now(),onP);
  });
}
function fetchOnce(url,onP){
  var alt=cdnUrl(url);
  if(alt){
    return fetch(alt).then(function(r){
      if(!r.ok)throw new Error("cdn "+r.status);
      var pr=onP?r.headers.get("content-length"):null;
      return r.arrayBuffer().then(function(b){if(onP)onP(1);return new Uint8Array(b)});
    }).catch(function(e){return fetchOnce(url,onP)});
  }
  return fetch(url).then(function(r){
    if(!r.ok)throw new Error(r.status);
    var total=+(r.headers.get("content-length")||0);
    if(!r.body||!r.body.getReader||!total)return r.arrayBuffer().then(function(b){return new Uint8Array(b)});
    var rd=r.body.getReader(),parts=[],got=0;
    function step(){
      return rd.read().then(function(x){
        if(x.done){var out=new Uint8Array(got),off=0;parts.forEach(function(p){out.set(p,off);off+=p.length});return out}
        parts.push(x.value);got+=x.value.length;
        if(onP)onP(got,total);
        return step();
      });
    }
    return step();
  });
}
function bin(p,onP){
  if(BLOB[p])return Promise.resolve(BLOB[p]);
  return fetchAll(new URL(p,BASE).href,onP?function(g,t){onP(t?g/t:0)}:null).then(function(u){
    var iv=u.slice(16,28),ct=u.slice(28);
    var salt=""; for(var i=0;i<16;i++)salt+=String.fromCharCode(u[i]);
    return dec(iv,ct,btoa(salt)).then(function(b){BLOB[p]=URL.createObjectURL(new Blob([b],{type:mime(b)}));return BLOB[p]});
  });
}

function headHtml(d){
  if(!d.sub)return "";
  var txt=d.sub;
  if(d.items&&d.items.length){
    var vis=d.items.filter(function(it){return !H("seg:"+it.id)});
    if(vis.length!==d.items.length){
      var total=vis.reduce(function(s2,i2){return s2+Math.max(0,i2.e-i2.s)},0);
      var places=[]; vis.forEach(function(i2){if(i2.loc&&places.indexOf(i2.loc)<0)places.push(i2.loc)});
      txt=[vis.length?vis.length+" 段记录":"", total?"共 "+dur(total):"", places.join(" / ")].filter(Boolean).join(" · ")||"这天没有记录";
    }
  }
  return '<div class="hd"><div class="sub">'+txt+'</div></div>';
}
function weekHtml(d){
  var w=d.week;
  if(!w)return "";
  var gw=w.place?w.place:"";
  var s=0,hours=String(w.hours||"").replace(/小时$/,"");
  var n=w.days||0, segs=w.segs||0;
  if(n>=3)return '<section class="wk only">'+
    '<div class="wh">最近 '+w.win+' 天</div><div class="wg">'+
    '<div><b>'+n+'</b><span>天有记录</span></div>'+
    '<div><b>'+segs+'</b><span>段片段</span></div>'+
    '<div><b>'+hours+'</b><span>小时</span></div>'+
    (gw?'<div><b style="font-size:13px;line-height:1.7">'+gw+'</b><span>常在的地方</span></div>':'')+
    '</div></section>';
  return "";
}

function hlHtml(d){
  var h=weekHtml(d);
  if(d.journal&&!H("jrn:"+d.journal.id))h+='<section class="box hlimg">'+
    '<div class="lb"><span>插画</span><span>'+(d.journal.t||"Looki 画")+'</span></div>'+
    '<div class="bd"><div class="h">'+d.journal.title+'</div>'+(d.journal.desc?'<p>'+d.journal.desc+'</p>':'')+'</div>'+
    pic(d.journal.img,"jrn",d.journal.lq,d.journal.w,d.journal.h,d.journal.full)+
    (OWN?'<button class="del" data-k="jrn:'+d.journal.id+'">删除</button>':'')+'</section>';
  if(d.comic&&!H("cmc:"+d.comic.id))h+='<section class="box hlimg">'+
    '<div class="lb"><span>漫画</span><span>'+(d.comic.secs||"Looki 画")+'</span></div>'+
    '<div class="bd"><div class="h">'+d.comic.title+'</div>'+(d.comic.desc?'<p>'+d.comic.desc+'</p>':'')+'</div>'+
    pic(d.comic.src,"cmi",d.comic.lq,d.comic.w,d.comic.h,d.comic.full)+
    (OWN?'<button class="del" data-k="cmc:'+d.comic.id+'">删除</button>':'')+'</section>';
  if(d.vlog&&d.vlog.src&&!H("vl:"+d.vlog.id))h+='<section class="box vid hlimg">'+
    '<div class="lb"><span>vlog</span><span>'+(d.vlog.secs?d.vlog.secs+" 秒":"")+'</span></div>'+
    '<div class="bd"><div class="h">'+d.vlog.title+'</div>'+(d.vlog.desc?'<p>'+d.vlog.desc+'</p>':'')+'</div>'+
    '<div class="pl"><video id="vlogv" controls playsinline preload="none" style="opacity:0"></video><button class="play" id="vplay"><span>▶</span></button></div>'+
    (OWN?'<button class="del" data-k="vl:'+d.vlog.id+'">删除</button>':'')+'</section>';
  return h||'<p class="empty">这天还没有插画或影像</p>';
}
function segsHtml(d){
  if(!(d.items&&d.items.length))return '<p class="empty">这天没有记录</p>';
  // 轨道固定铺满 00:00-24:00（1440 分钟），下午空着就是空着，跟人脑子里的时钟一致
  var P2=function(m){return Math.max(0,Math.min(100,m/1440*100))};
  var h='<div class="sw"><aside class="rail" id="rail"><i class="rc"></i>';
  [0,6,12,18,24].forEach(function(hr){
    var y=hr/24*100;
    h+='<i class="cs" style="top:'+y+'%"></i>';
    if(hr>0&&hr<24)h+='<i class="ct" style="top:'+y+'%">'+hr+'</i>';
  });
  d.items.forEach(function(it,i){
    if(H("seg:"+it.id))return;
    var a=P2(it.s), b2=P2(it.e);
    h+='<b class="rs" data-i="'+i+'" style="top:'+a.toFixed(2)+'%;height:'+Math.max(1.4,b2-a).toFixed(2)+'%"></b>';
  });
  // 今天才画「现在」的白点：一眼看到自己正处在一天的哪个位置
  if(P.days[0]&&P.days[0].d===d.date){
    var nw=new Date(), mins=nw.getHours()*60+nw.getMinutes();
    h+='<i class="nm" style="top:'+P2(mins).toFixed(2)+'%"></i>';
  }
  h+='<u class="rp" id="railp" style="top:0"></u></aside><div class="sc" id="sc">'+d.items.map(card).join("")+'</div></div>';
  return h;
}
function card(it,i){
  if(H("seg:"+it.id))return "";
  var h='<article class="card" id="seg-'+i+'">';
  h+=pic(it.img,"c"+i,it.lq,it.w,it.h,it.full);
  h+='<div class="t"><span class="dot"></span>'+it.t+'<em>'+dur(Math.max(0,it.e-it.s))+'</em></div>';
  h+='<div class="h">'+it.title+'</div>';
  if(it.desc){
    if(it.desc.length>150)h+='<p class="dc">'+it.desc+'</p><button class="more">展开全文</button>';
    else h+='<p>'+it.desc+'</p>';
  }
  h+='<div class="foot">';
  if(it.tags&&it.tags.length)h+='<div class="tags">'+it.tags.map(function(x){return "<span>"+x+"</span>"}).join("")+'</div>';
  if(it.loc)h+='<div class="loc">'+it.loc+'</div>';
  if(OWN)h+='<button class="del" data-k="seg:'+it.id+'">删除</button>';
  return h+'</div></article>';
}
function timeHtml(d){
  if(!(d.items&&d.items.length))return '<p class="empty">这天没有记录</p>';
  var segs=d.sumSegs||[];
  var head=(!segs.length&&d.summary)?'<p class="dp">'+d.summary+'</p>':'';
  return head+'<div class="tlst">'+d.items.map(function(it,i){
    if(H("seg:"+it.id))return "";
    var sm=null;
    for(var k=0;k<segs.length;k++){if(it.t.indexOf(segs[k].a)===0){sm=segs[k];break}}
    var nm=it.title+'<i>'+(it.e-it.s>=1?dur(it.e-it.s):"")+(it.loc?" · "+it.loc:"")+'</i>';
    var ex='';
    if(sm){ex='<span class="dx"><b>'+(sm.place||it.loc||"")+'</b><em>'+sm.desc+'</em></span>';}
    return '<button data-i="'+i+'"><span class="tt">'+it.t+'</span><span class="nm">'+nm+ex+'</span></button>';
  }).join("")+'</div>';
}
function textHtml(d){
  var h='<div class="morewrap">';
  var hasSum=false;   // 今日总结已并入「时段」
  var hasRec=!!(d.recap&&d.recap.html);
  var hasHealth=!!(d.health&&(d.health.insight||d.health.intake||d.health.burn));
  h+='<div class="moretabs">';
  if(hasSum)h+='<button data-k="sum">总结</button>';
  if(hasRec)h+='<button data-k="recap">对话</button>';
  if(hasHealth)h+='<button data-k="health">健康</button>';
  h+='</div>';
  if(hasSum){
    h+='<div class="morepane" data-k="sum">';
    if(d.sumSegs&&d.sumSegs.length){
      h+='<div class="sums">';
      d.sumSegs.forEach(function(x){
        h+='<div class="sm"><div class="st">'+x.a+'–'+x.b+'</div><div class="sx">'+
          (x.place?'<b>'+x.place+'</b>':'')+'<p>'+x.desc+'</p></div></div>';
      });
      h+='</div>';
    } else h+='<p class="dp">'+d.summary+'</p>';
    if(OWN)h+='<button class="del" data-k="sum:'+d.date+'">删除这天的总结</button>';
    h+='</div>';
  }
  if(hasRec){
    h+='<div class="morepane" data-k="recap" hidden>';
    h+='<section class="recap">'+d.recap.title;
    if(d.recap.chips&&d.recap.chips.length)
      h+='<div class="rc">'+d.recap.chips.map(function(x){return '<span>'+x+'</span>'}).join("")+'</div>';
    h+=d.recap.html+(OWN?'<button class="del" data-k="rcp:'+(d.recap.id||"")+'">删除</button>':'')+'</section></div>';
  }
  if(hasHealth&&!H("hlt:"+d.date)){
    h+='<div class="morepane" data-k="health" hidden>'+healthHtml(d)+
      (OWN?'<button class="del" data-k="hlt:'+d.date+'">删除这份健康报告</button>':'')+'</div>';
  }
  h+='</div>';
  return h||'<p class="empty">这天的总结还没生成（平台一般隔天出）</p>';
}
function calChart(H){
  var pts=H.intakeAt, hi=0;
  pts.forEach(function(p){var u=p[1].split("-");hi=Math.max(hi,+(u[1]||0))});
  hi=Math.max(hi,200)*1.12;
  var W=300,H2=88,base=H2-15,top=8,pad=2, n=pts.length, gw=(W-pad*2)/n, bw=Math.min(30,gw*0.58);
  var s='<div class="cal"><div class="clb"><span>每餐摄入区间</span>'+
    (H.burn?'<span>全天消耗约 '+H.burn+' kcal</span>':'<span>kcal</span>')+'</div>'+
    '<svg viewBox="0 0 '+W+' '+H2+'" preserveAspectRatio="none" role="img">';
  s+='<line x1="0" y1="'+base+'" x2="'+W+'" y2="'+base+'" stroke="#242d29"/>';
  pts.forEach(function(p,i){
    var u=p[1].split("-"), lo=+(u[0]||0), up=+(u[1]||lo);
    var x=pad+i*gw+(gw-bw)/2;
    var y1=base-lo/hi*(base-top), y0=base-up/hi*(base-top);
    s+='<rect x="'+x.toFixed(1)+'" y="'+y0.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(3,y1-y0).toFixed(1)+'" rx="3" fill="#9fd08a" opacity="0.9"/>';
    s+='<text x="'+(x+bw/2).toFixed(1)+'" y="'+(y0-4).toFixed(1)+'" fill="#7d8b7a" font-size="8.5" text-anchor="middle">'+up+'</text>';
  });
  s+='</svg><div class="cax">';
  pts.forEach(function(p){s+='<span>'+p[0]+'</span>'});
  s+='</div></div>';
  return s;
}
function healthHtml(d){
  var H=d.health;
  if(!(H&&(H.insight||H.intake||H.burn)))return '<p class="empty">这天还没有健康报告</p>';
  var h='<section class="hl">';
  if(H.range)h+='<div class="lb"><span>每日健康 · 估算</span><span>'+H.range+'</span></div>';
  else h+='<div class="lb"><span>每日健康 · 估算</span></div>';
  if(H.insight)h+='<div class="hsect"><h4>今日重点</h4><div class="ins">'+H.insight+'</div></div>';
  if(H.intake||H.burn){
    h+='<div class="hstat">';
    if(H.intake)h+='<div class="hs"><span>摄入估算</span><b>'+H.intake+'</b><i>kcal'+(H.mid?' · 中值 '+H.mid:'')+'</i></div>';
    if(H.burn)h+='<div class="hs burn"><span>能量消耗</span><b>'+H.burn+'</b><i>kcal · 估算</i></div>';
    h+='</div>';
  }
  if(H.metrics)h+='<div class="met">'+H.metrics+'</div>';
  if(H.intakeAt&&H.intakeAt.length)h+=calChart(H);
  if(H.diet&&H.diet.length){
    h+='<div class="hsect"><h4>饮食回顾</h4>';
    H.diet.forEach(function(x){h+='<div class="rv"><b>'+x.t+'</b><p>'+x.x+'</p></div>'});
    h+='</div>';
  }
  if(H.events&&H.events.length){
    h+='<div class="hsect"><h4>当天时间线</h4><div class="evs">';
    H.events.forEach(function(e){
      var k=e.k||0, cls=k>0?"up":"dn";
      h+='<div class="ev"><span class="et">'+e.t+'</span><span class="ex">'+e.x+'</span>'+
        (k?'<span class="ek '+cls+'">'+(k>0?'+':'')+k+'</span>':'')+'</div>';
    });
    h+='</div></div>';
  }
  return h+'</section>';
}
function tabChips(d){
  var cur=document.querySelector("#tabs button.on");   // 必须在重建 innerHTML 前取，否则拿到 null
  var keep=cur&&cur.dataset.tab;
  var has={};
  has.hl=!!((d.journal&&d.journal.img)||(d.comic&&d.comic.src)||(d.vlog&&d.vlog.src));
  has.segs=!!(d.items&&d.items.length);
  has.time=has.segs;
  has.more=!!((d.recap&&d.recap.html)||(d.health&&(d.health.insight||d.health.intake||d.health.burn)));
  var h="",n=0;
  TABS.forEach(function(t){if(has[t[0]]){h+='<button data-tab="'+t[0]+'">'+t[1]+'</button>';n++;}});
  $("tabs").innerHTML=h; $("tabs").hidden=(n<2);
  // 切日期时尽量停在同一个页签（在片段页切日期就还在片段页，不会跳回「精彩」）
  if(keep&&has[keep])return keep;
  var first=""; TABS.forEach(function(t){if(!first&&has[t[0]])first=t[0]});
  return first||"segs";
}
function setTab(name){
  document.querySelectorAll(".tab").forEach(function(s){s.hidden=s.dataset.tab!==name});
  document.querySelectorAll("#tabs button").forEach(function(b){b.classList.toggle("on",b.dataset.tab===name)});
  var hd=document.querySelector("header");
  var mn=document.querySelector("main");
  if(hd&&mn){
    var pad=parseFloat(getComputedStyle(mn).paddingTop)||0;
    document.documentElement.style.setProperty("--hh",(hd.getBoundingClientRect().height+pad)+"px");
  }
  CURTAB=name;
  document.body.classList.toggle("lock",name==="segs");
  window.scrollTo(0,0);
  if(name==="segs")setTimeout(syncRail,60);
}
// 左侧竖轨：点击跳转 + 右侧滚动时黄线实时跟着走
function railMark(i){
  document.querySelectorAll("#rail .rs").forEach(function(x){x.classList.toggle("on",+x.dataset.i===i)});
}
function railPct(p){
  var m=$("railp"); if(!m)return;
  m.style.top=Math.max(0,Math.min(100,p))+"%";
}
var LOCK=0;
function syncRail(){
  var rail=$("rail"), sc=document.querySelector(".sc");
  if(!rail||!sc)return;
  var d=window.__D, items=(d&&d.items)||[];
  var cards=[].slice.call(sc.querySelectorAll(".card"));
  if(!cards.length||!items.length)return;
  var cr0=sc.getBoundingClientRect();
  var line=cr0.top+cr0.height*0.38, i=0;
  for(var k=0;k<cards.length;k++){ if(cards[k].getBoundingClientRect().top<=line) i=k; }
  railMark(i);
  var cr=cards[i].getBoundingClientRect(), f=0;
  if(cr.height>1) f=Math.max(0,Math.min(1,(line-cr.top)/cr.height));
  var a=(items[i]&&items[i].s)||0, b2=(items[i+1]&&items[i+1].s)||(items[i]&&items[i].e)||a;
  railPct(Math.max(0,Math.min(100,(a+f*(b2-a))/1440*100)));
}
function jumpTo(i){
  if(!$("seg-"+i))return;
  var st=document.querySelector('.tab[data-tab="segs"]');
  var need=!!(st&&st.hidden);
  if(need)setTab("segs");           // 从「时段」点进来：先切到片段页，再滚（隐藏状态下量不到位置）
  setTimeout(function(){
    var el=$("seg-"+i); if(!el)return;
    var sc=$("sc");
    if(sc){
      // 只在右侧容器内滚，绝不带动整个页面（否则标题、时间轴会整块被顶上去）
      var top=el.getBoundingClientRect().top-sc.getBoundingClientRect().top+sc.scrollTop;
      sc.scrollTo({top:Math.max(0,top),behavior:"smooth"});
    }
    railMark(i);
    el.classList.add("flash"); setTimeout(function(){el.classList.remove("flash")},1500);
  }, need?90:0);
}

function loadVlog(d){
  var v=$("vlogv"),b=$("vplay"); if(!v||!d.vlog||!d.vlog.src)return;
  var pm=d.vlog.poster?bin(d.vlog.poster).catch(function(){return null}):Promise.resolve(null);
  pm.then(function(o){if(o){v.poster=o;v.style.opacity=1;v.style.background="transparent"}});
  if(b)b.onclick=function(){
    b.disabled=true; b.innerHTML='<span>0%</span>';
    bin(d.vlog.src,function(f){b.innerHTML='<span>'+Math.round(f*100)+'%</span>'}).then(function(o){v.src=o;v.style.opacity=1;b.hidden=true;v.play().catch(function(){})})
      .catch(function(e){b.disabled=false;b.innerHTML='<span>▶</span>';console.warn("vlog",e)});
  };
  v.addEventListener("play",function(){if(b)b.hidden=true},{once:true});
}

function render(d){
  cvStop();
  window.__D=d; VIEWDAY=d.date;
  try{
    localStorage.setItem("lc:"+d.date,JSON.stringify(d));
    var sg=daySigOf(d.date); if(sg)localStorage.setItem("lsig:"+d.date,sg);
    // 只留当前 7 天窗口内的缓存，更早的清掉（localStorage 只有 5MB）
    var keep={}; for(var i=0;i<P.days.length;i++)keep["lc:"+P.days[i].d]=1;
    var gone=[]; for(var j=0;j<localStorage.length;j++){var k=localStorage.key(j); if(k.indexOf("lc:")===0&&!keep[k])gone.push(k)}
    for(var g=0;g<gone.length;g++)localStorage.removeItem(gone[g]);
  }catch(e){}
  var gt=new Date(d.generatedAt),u=$("upd");
  u.textContent="内容 "+ago(Date.now()-gt.getTime()); u.className="";
  fetch(new URL("m/status.json",BASE).href+"?t="+Date.now()).then(function(r){return r.json()}).then(function(st){
    STAT=st||null;
    var sg=daySigOf(d.date);
    if(sg){try{localStorage.setItem("lsig:"+d.date,sg)}catch(e){}}
    var c=new Date(st.checkedAt),lag=(Date.now()-c.getTime())/60000;
    u.textContent="内容 "+ago(Date.now()-gt.getTime())+" · 检查 "+ago(Date.now()-c.getTime());
    if(lag>240){u.className="stale";u.textContent+="（可能卡住了）"}
  }).catch(function(){});
  $("dayname").textContent=d.date+" "+d.wd;

  var out='';
  out+='<section class="tab" data-tab="hl">'+headHtml(d)+hlHtml(d)+'</section>';
  out+='<section class="tab" data-tab="segs" hidden><div class="segwrap">'+
    '<div class="seghead">'+headHtml(d)+'</div>'+segsHtml(d)+'</div></section>';
  out+='<section class="tab" data-tab="time" hidden>'+headHtml(d)+timeHtml(d)+'</section>';
  out+='<section class="tab" data-tab="more" hidden>'+headHtml(d)+textHtml(d)+'</section>';
  $("app").innerHTML=out;
  var stray=$("app").querySelectorAll(".skel"); for(var si=0;si<stray.length;si++)stray[si].remove();
  $("days").hidden=false;
  var startTab=tabChips(d); chips(); setTab(startTab);
  if(PENDTAB){
    var tt=tabsOf(d);
    if(tt.length){
      var goal=PENDTAB==="last"?tt[tt.length-1]:tt[0];
      setTab(goal);
      if(goal==="more"&&PENDTAB==="last"){var pk=paneKeys();if(pk.length)setPane(pk[pk.length-1])}
    }
    PENDTAB=null;
  }
  $("tabs").querySelectorAll("button").forEach(function(b){b.onclick=function(){setTab(b.dataset.tab)}});
  document.querySelectorAll("#rail .rs").forEach(function(s){s.onclick=function(){jumpTo(+s.dataset.i)}});
  document.querySelectorAll(".card .more").forEach(function(b){b.onclick=function(){
    var p2=b.parentNode.querySelector("p.dc"); p2.classList.toggle("open");
    b.textContent=p2.classList.contains("open")?"收起":"展开全文"; syncRailSoon();
  }});
  document.querySelectorAll(".tlst button").forEach(function(s){s.onclick=function(){jumpTo(+s.dataset.i)}});
  document.querySelectorAll(".moretabs button").forEach(function(b){b.onclick=function(){
    document.querySelectorAll(".moretabs button").forEach(function(x){x.classList.toggle("on",x===b)});
    document.querySelectorAll(".morepane").forEach(function(p2){p2.hidden=p2.dataset.k!==b.dataset.k});
    window.scrollTo(0,0);
  }});
  var mb=document.querySelector(".moretabs button");
  if(mb){mb.classList.add("on");
    document.querySelectorAll(".morepane").forEach(function(p2){p2.hidden=p2.dataset.k!==mb.dataset.k});}
  document.querySelectorAll("#app .del").forEach(function(b){b.onclick=function(e){e.preventDefault();e.stopPropagation();askDel(b.dataset.k)}});
  // 事件委托：任何带 data-full 的缩略图点开就是高清
  $("app").onclick=lbClick;
  var rl=$("rail");
  if(rl){rl.onclick=function(e){
    var t=e.target.closest("[data-i]"); if(!t)return;
    e.preventDefault(); jumpTo(+t.dataset.i);
  };}
  loadVlog(d);
  $("gate").classList.remove("show");
  $("app").hidden=false;
  Q=[]; RUN=0; if(IO){IO.disconnect();IO=null} NEAR=null;
  setTimeout(pumpNear,60);            // 首屏主动催一次，不靠用户先滑
}

// 从页面 HTML 里抠出 var E={...} 的密文（按大括号配平，别用 indexOf 猜结尾）
function parseE(t){
  var a=t.indexOf("var E="); if(a<0)throw new Error("no E");
  var i=t.indexOf("{",a),d=0,inS=false,esc=false;
  for(var j=i;j<t.length;j++){
    var c=t[j];
    if(inS){ if(esc){esc=false} else if(c==="\\\\"){esc=true} else if(c==='"'){inS=false} continue }
    if(c==='"'){inS=true;continue}
    if(c==="{")d++;
    else if(c==="}"){d--;if(d===0)return JSON.parse(t.slice(i,j+1))}
  }
  throw new Error("bad E");
}
// 本地缓存必须跟云端当前这天的图片签名对得上，否则丢弃重取（防止旧缓存指向已被清理的图 → 整页空白）
var STAT=null;
function daySigOf(day){ return (STAT&&STAT.sigs&&STAT.sigs[day])||"" }
function dayCache(day){
  try{
    var o=JSON.parse(localStorage.getItem("lc:"+day)||"null");
    if(!o||o.date!==day)return null;
    var want=daySigOf(day);
    var got=localStorage.getItem("lsig:"+day)||"";
    if(want&&got!==want){ return null }   // 云端这天的图片签名变了（图被换/被清）→ 本地这份不可信
    return o;
  }catch(e){return null}
}
function switchDay(day){
  if(!day||day===(window.__D&&window.__D.date))return;
  if(!PASS){showGate("先输口令");return}
  var old=window.__D;
  // 只下载「点开的那一天」：进页面只加载今天（首屏自带+按需懒加载图片），其余天一律点了才取。
  // 取过的日子放 localStorage，再点回去 0 字节（今天除外——今天还在长数据，必须刷最新）。
  var isToday=!!(P.days[0]&&P.days[0].d===day);
  var hit=isToday?null:dayCache(day);
  if(hit){
    P.day=day; history.pushState({day:day},"",BASE+"d/"+day+".html"+(PASS?"#k="+PASS:""));
    hideLoad(); render(hit);
    return;
  }
  var sk=document.createElement("div");sk.className="skel";var m=$("app");m.insertBefore(sk,m.firstChild);
  $("dayname").textContent=day;
  fetch(BASE+"d/"+day+".html").then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.text()}).then(function(t){
    var obj=parseE(t);
    return page(PASS,obj);
  }).then(function(d){
    if(sk.parentNode)sk.parentNode.removeChild(sk);
    P.day=day; history.pushState({day:day},"",BASE+"d/"+day+".html"+(PASS?"#k="+PASS:""));
    hideLoad(); render(d);
  }).catch(function(e){
    console.warn("switchDay",e);
    if(sk.parentNode)sk.parentNode.removeChild(sk);
    if(old)$("dayname").textContent=old.date+" "+old.wd;
    toast("这一天还没生成，或者网络不好");
  });
}
function askDel(k){
  var el=document.createElement("div"); el.className="cfm";
  el.innerHTML='<div class="bx"><p>删掉这条？谁拿到链接都看不到了，删了不能恢复。</p>'+
    '<div class="row"><button class="cancel">取消</button><button class="danger">删除</button></div></div>';
  document.body.appendChild(el);
  el.querySelector(".cancel").onclick=function(){el.remove()};
  el.querySelector(".danger").onclick=function(){el.remove();hideAdd(k)};
}
function toast(msg){
  var t=document.createElement("div");
  t.textContent=msg;
  t.style.cssText="position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:#1e2229;border:1px solid #2c333d;color:#dfe3e8;padding:9px 16px;border-radius:10px;font-size:13px;z-index:120;max-width:80%;text-align:center";
  document.body.appendChild(t);
  setTimeout(function(){t.style.opacity="0";t.style.transition="opacity .3s";setTimeout(function(){t.remove()},320)},2200);
}
function showGate(tip){
  $("app").hidden=true; $("gate").classList.add("show");
  if(tip)$("err").textContent=tip;
  setTimeout(function(){try{$("pw").focus()}catch(e){}},60);
}
function enter(d){
  window.__D=d;
  if(d&&d.cover){COVERD=d.cover; showCover(); return}
  render(d);
}
function unlock(cred,fromHash){
  PASS=cred; resetKeys();
  page(cred,E).then(function(d){
    OWN=true; try{localStorage.setItem("own","1")}catch(e){}
    try{localStorage.setItem("lp",cred)}catch(e){}
    if(fromHash)history.replaceState(null,"",location.pathname+location.search+"#k="+cred);
    hideLoad();                 // 不 await：删除标记会立刻用本地那份，云端只是后台补
    enter(d);
  }).catch(function(){
    // 不是主人口令，再试「邀请码」：邀请码解出来的是主人口令，只放在内存里
    return tryInvite(cred).then(function(master){
      PASS=master; resetKeys(); OWN=false; try{localStorage.setItem("own","0")}catch(e){}
      try{localStorage.setItem("lp",cred)}catch(e){}
      if(fromHash)history.replaceState(null,"",location.pathname+location.search+"#inv="+cred);
      return page(master,E).then(function(d){ hideLoad(); enter(d) });
    });
  }).catch(function(){
    PASS=null;resetKeys();OWN=false;
    showGate(fromHash?"链接已失效，可以手动输口令或邀请码":"口令或邀请码不对");
  });
}
$("go").onclick=function(){
  var v=$("pw").value.trim(); if(!v)return;
  $("err").textContent="解密中…";
  unlock(v,true);
};
$("pw").addEventListener("keydown",function(e){if(e.key==="Enter")$("go").click()});
function syncRailSoon(){
  setTimeout(syncRail,120);
  if(!NEART)NEART=setTimeout(function(){NEART=null;pumpNear()},140);
}

/* ---------- 左右滑动：页签 → 记录子页 → 前一天/后一天 ---------- */
var PENDTAB=null;
function tabsOf(d){
  var has={};
  has.hl=!!((d.journal&&d.journal.img)||(d.comic&&d.comic.src)||(d.vlog&&d.vlog.src));
  has.segs=!!(d.items&&d.items.length); has.time=has.segs;
  has.more=!!((d.recap&&d.recap.html)||(d.health&&(d.health.insight||d.health.intake||d.health.burn)));
  var a=[]; TABS.forEach(function(t){if(has[t[0]])a.push(t[0])}); return a;
}
function paneKeys(){return [].slice.call(document.querySelectorAll(".morepane")).map(function(x){return x.dataset.k})}
function setPane(k){
  var t=[].slice.call(document.querySelectorAll(".moretabs button")).filter(function(b){return b.dataset.k===k})[0];
  if(t)t.click();
}
function swipeFlash(dir){
  var a=$("app"); if(!a||!a.animate)return;
  a.animate([{opacity:.42,transform:"translateX("+(dir>0?-16:16)+"px)"},{opacity:1,transform:"none"}],
    {duration:220,easing:"cubic-bezier(.2,.8,.3,1)"});
}
function swipeNav(dir){
  if(INVIEW==="cover"){ if(dir>0){swipeFlash(1);openDay(P.days[0].d)} return; }
  if(INVIEW==="inv"){ if(dir<0){swipeFlash(-1);showCover()} return; }
  var d=window.__D; if(!d)return;
  var tabs=tabsOf(d), i=tabs.indexOf(CURTAB); if(i<0)i=0;
  if(CURTAB==="more"){
    var keys=paneKeys(), el=document.querySelector(".morepane:not([hidden])");
    var ci=keys.indexOf(el?el.dataset.k:keys[0]); if(ci<0)ci=0;
    if(keys.length>1&&((dir>0&&ci<keys.length-1)||(dir<0&&ci>0))){swipeFlash(dir);setPane(keys[ci+dir]);return;}
  }
  var j=i+dir;
  if(j>=0&&j<tabs.length){swipeFlash(dir);setTab(tabs[j]);return;}
  var k=-1; for(var q=0;q<P.days.length;q++)if(P.days[q].d===d.date)k=q;
  if(k<0)return;
  var nk=k+dir;
  while(nk>=0&&nk<P.days.length&&P.days[nk].has===false)nk+=dir;   // 空白天跳过
  if(nk<0||nk>=P.days.length)return;
  PENDTAB=dir>0?"first":"last";
  swipeFlash(dir);
  openDay(P.days[nk].d);
}
var RAILT=0;
document.addEventListener("scroll",function(){
  if(RAILT)return;
  RAILT=setTimeout(function(){RAILT=0;syncRail()},90);
},{capture:true,passive:true});
window.addEventListener("popstate",function(e){
  var st=e.state&&e.state.day;
  var p=(location.pathname.match(/\\/d\\/(\\d{4}-\\d{2}-\\d{2})\\.html$/)||[])[1];
  switchDay(st||p);
});
(function(){
  var bx=$("lbx"); if(bx)bx.onclick=lbClose;
  var stg=$("lbstage"); if(stg)stg.onclick=function(e){ if(e.target&&e.target.id==="lbimg")stg.classList.toggle("zoom") };
  var lb=$("lb"); if(lb)lb.onclick=function(e){ if(e.target===lb||e.target.className==="lbstage")lbClose() };
  window.addEventListener("keydown",function(e){ if(e.key==="Escape")lbClose() });
})();
(function(){
  var sx=0,sy=0,st=0,on=false;
  document.addEventListener("touchstart",function(e){
    if(e.touches.length!==1)return; sx=e.touches[0].clientX; sy=e.touches[0].clientY; st=Date.now(); on=true;
  },{passive:true});
  document.addEventListener("touchend",function(e){
    if(!on)return; on=false;
    var t=e.changedTouches[0]; if(!t)return;
    var dx=t.clientX-sx, dy=t.clientY-sy;
    if(Date.now()-st>1000)return;
    if(Math.abs(dx)<62||Math.abs(dx)<Math.abs(dy)*1.5)return;
    var lbx=$("lb"); if(lbx&&!lbx.hidden)return;
    swipeNav(dx<0?1:-1);
  },{passive:true});
})();
(function(){
  var h=(location.hash||"");
  var inv=h.indexOf("#inv=")===0?h.slice(5):"";
  var tk=h.indexOf("#k=")===0?h.slice(3):"";
  var lp=null; try{lp=localStorage.getItem("lp")}catch(e){}
  var own=false; try{own=localStorage.getItem("own")==="1"}catch(e){}
  OWN=own;
  chips();
  if(inv){unlock(inv,true);}
  else if(tk){unlock(tk,true);}
  else if(lp){unlock(lp,false);}
  else {showGate();}
})();
// ── 立即刷新：点一下 → 往 ntfy 主题投一条信号 → 云端 runner 轮询到就提前跑一轮抓取 ──
// 同时用 EventSource 订阅同一主题，别处点了刷新，这边页头也会亮一条「正在更新」。
var RFBUSY=false, RFWAIT=null, RFLAST=0, RFES=null;
function rfBar(on,txt){
  var n=$("rfn"), t=$("rfnt");
  if(n){ n.hidden=!on; }
  if(on&&t&&typeof txt==="string"&&txt)t.textContent=txt;
}
function rfShow(on,keepBusy){
  var o=$("rfo"), b=$("rfb");
  if(o)o.hidden=!on;
  if(b)b.classList.toggle("busy",!!(on||keepBusy));
  RFBUSY=!!on;
  if(on)rfBar(true,"正在刷新内容…");
  else if(!keepBusy)rfBar(false);
}
// 等 m/status.json 前进一步 → 自动重载。本机点击和别人点的那条共用，避免开两个定时器。
function rfWait(fromRemote){
  if(RFWAIT)return;
  var t0=Date.now(), base=(STAT&&STAT.checkedAt)?new Date(STAT.checkedAt).getTime():0, tries=0;
  RFWAIT=setInterval(function(){
    tries++;
    var sec=Math.round((Date.now()-t0)/1000);
    var o=$("rfo");
    if($("rfs")&&o&&!o.hidden)$("rfs").textContent="正在从 Looki 抓取最新内容 · 已等 "+sec+" 秒";
    if($("rfn")&&!$("rfn").hidden)$("rfnt").textContent=(fromRemote?"有人正在刷新":"正在更新内容")+" · 已等 "+sec+" 秒";
    fetch(new URL("m/status.json",BASE).href+"?t="+Date.now(),{cache:"no-store"})
      .then(function(r){return r.json()})
      .then(function(st){
        var ts=(st&&st.checkedAt)?new Date(st.checkedAt).getTime():0;
        if(!base&&ts){base=ts;return;}      // 第一次拿到当前值当基线，避免页面没读到 status 时永远等
        if(base&&ts>base+1000){
          clearInterval(RFWAIT); RFWAIT=null; STAT=st;
          if($("rfm"))$("rfm").textContent="已更新";
          if($("rfs"))$("rfs").textContent="正在载入新内容…";
          if($("rfnt"))$("rfnt").textContent="已更新，正在载入…";
          setTimeout(function(){ location.reload(); },500);
        }
      }).catch(function(){});
    if(tries>=240){
      clearInterval(RFWAIT); RFWAIT=null;
      if($("rfo")&&!$("rfo").hidden)rfShow(false); else rfBar(false);
      toast(fromRemote?"这次没等到更新，刷新一下页面看看":"已经通知云端刷新了，稍等一下再点刷新看");
    }
  },2000);
}
function rfGo(){
  if(RFBUSY)return;
  var t0=Date.now();
  RFLAST=t0;
  rfShow(true);
  if($("rfm"))$("rfm").textContent="正在刷新…";
  if($("rfs"))$("rfs").textContent="正在从 Looki 抓取最新内容，通常 1 分钟内好";
  fetch("https://ntfy.sh/"+RF,{method:"POST",body:"refresh "+t0,headers:{"Content-Type":"text/plain"}})
    .then(function(r){ if(!r||!r.ok) toast("刷新信号可能没发出去，仍会继续等一下"); })
    .catch(function(){ toast("刷新信号没发出去，检查一下网络"); });
  rfWait(false);
}
// 跨设备状态：订阅 ntfy 主题，别人点了刷新这边页头也会亮条；页面不可见时断开省电省流量。
function rfWatch(){
  if(!window.EventSource||!RF)return;
  try{
    if(RFES){ try{RFES.close()}catch(e){} RFES=null; }
    var es=new EventSource("https://ntfy.sh/"+RF+"/sse?since=10s");
    RFES=es;
    es.onmessage=function(ev){
      var m=null; try{ m=JSON.parse(ev.data) }catch(e){ return }
      if(!m||m.event!=="message")return;                 // open/keepalive 之类忽略
      var s=String(m.message||"");
      if(s.indexOf("refresh")!==0)return;
      var at=parseInt(s.slice(7),10)||0;
      if(at&&RFLAST&&Math.abs(at-RFLAST)<20000)return;    // 自己刚点的那条
      if(RFWAIT)return;
      rfBar(true,"有人正在刷新，好了会自动更新…");
      rfWait(true);
    };
    es.onerror=function(){ /* EventSource 自己会重连，连不上就安静降级，不打扰用户 */ };
  }catch(e){}
}
(function(){
  var b=$("rfb"); if(b)b.onclick=rfGo;
  // 点遮罩只是收起面板，后台继续等，好了自动刷新
  var o=$("rfo");
  if(o)o.onclick=function(e){ if(e.target===o){ rfShow(false,true); toast("继续在后台等，好了会自动刷新"); } };
  rfWatch();
  document.addEventListener("visibilitychange",function(){
    if(document.hidden){ if(RFES){ try{RFES.close()}catch(e){} RFES=null; } }
    else if(!RFES && !RFWAIT) rfWatch();
  });
})();
window.X={get PASS(){return PASS},get BASE(){return BASE},get P(){return P},get CACHE(){return CACHE},rfGo:rfGo};
</script></body></html>`;
}

function builtLabel(p) {
  const f = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(p.generatedAt));
  return f.replace("/", "-");
}

// Looki 生成的 markdown 小标题/列表 → 简单 HTML
const LBL = /^(概览|洞察|建议|整体|饮食|运动|作息|总结|热量)[\uFF1A:]/;
function mdLite(s = "") {
  const lines = String(s).split("\n").map(l => l.trim()).filter(Boolean);
  let out = "", inList = false;
  const split = [];
  for (const l of lines) {
    const segs = l.split(/[\uFF1B;]/).map(x => x.trim()).filter(Boolean);
    if (segs.length > 1 && segs.some(x => LBL.test(x))) split.push(...segs);
    else split.push(l);
  }
  const flat = [];
  for (const l of split) {
    const m = l.match(LBL);
    if (m) { flat.push("#### " + m[1]); const rest = l.slice(m[0].length).trim(); if (rest) flat.push(rest); }
    else flat.push(l);
  }
  for (const l of flat) {
    if (/^#{2,4}\s+/.test(l)) {
      if (inList) { out += "</ul>"; inList = false; }
      out += `<h4>${esc(l.replace(/^#{2,4}\s+/, ""))}</h4>`;
    } else if (/^[-*]\s+/.test(l)) {
      if (!inList) { out += "<ul>"; inList = true; }
      out += `<li>${esc(l.replace(/^[-*]\s+/, "").replace(/\*\*/g, ""))}</li>`;
    } else if (/^>\s?/.test(l)) {
      if (inList) { out += "</ul>"; inList = false; }
      out += `<blockquote>${esc(l.replace(/^>\s?/, "").replace(/\*\*/g, ""))}</blockquote>`;
    } else {
      if (inList) { out += "</ul>"; inList = false; }
      out += `<p>${esc(l.replace(/\*\*/g, ""))}</p>`;
    }
  }
  if (inList) out += "</ul>";
  return out;
}

async function buildDay(day, prev = new Map()) {
  const ms = (await paged("/moments", { start_date: day, end_date: day, limit: 50 }))
    .sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));

  // 日记 / 漫画 / vlog / 昨日回顾（同一个 journals 接口，按 type 分）
  let journal = null, comic = null, vlog = null, recap = null;
  try {
    const js = await paged("/journals", { start_date: day, end_date: day, limit: 30 });
    const by = (t) => js.find(x => (x.type || "") === t);
    const j = by("DIARY");
    if (j) journal = { id: j.id || "", title: esc(j.title || "日记"), desc: esc(clip(j.description, 200)), img: null, _url: j.media_items?.[0]?.source?.temporary_url };
    const c = by("COMIC_PAGE");
    if (c) comic = { id: c.id || "", title: esc(c.title || "漫画"), desc: esc(clip(c.description, 200)), src: null, _url: c.media_items?.[0]?.source?.temporary_url };
    const v = by("DAILY_VLOG");
    if (v) {
      const src = v.media_items?.[0]?.source;
      vlog = {
        id: v.id || "",
        title: esc(v.title || "今日 vlog"),
        desc: esc(clip(v.description, 300)),
        secs: src?.metadata?.duration_ms ? Math.round(src.metadata.duration_ms / 1000) : 0,
        src: null, poster: null,
        _url: src?.temporary_url,
        _poster: v.media_items?.[0]?.thumbnail?.temporary_url,
      };
    }
    const r = by("YESTERDAY_RECAP");
    if (r && (r.content || r.description)) {
      let raw = String(r.content || r.description || "").trim();
      const first = raw.split("\n")[0];
      let chips = [];
      if (/^\*\*.+\*\*/.test(first) && first.includes("·")) {
        chips = first.split("·").map(x => x.replace(/\*\*/g, "").trim()).filter(Boolean);
        raw = raw.split("\n").slice(1).join("\n").trim();
      }
      recap = { id: r.id || "", title: esc(r.title || "昨日回顾"), chips, html: mdLite(raw) };
    }
  } catch (e) { console.error(`[warn] journals 失败：${e.message}`); }

  // 每日健康报告（窗口 05:00–次日 05:00，含热量/饮食点评/事件流）
  let health = null;
  try {
    const hs = await paged("/health-reports", { start_date: day, end_date: day });
    const d0 = hs[0]?.report_data;
    if (d0) {
      const cal = String(d0.calorie || "");
      const grab = (re) => { const m = cal.match(re); return m ? m[1].trim() : ""; };
      const intake = grab(/摄入估算[:：]\s*([0-9]+\s*[–\-~]\s*[0-9]+)\s*kcal/);
      const mid = grab(/中值约\s*([0-9]+)/);
      const burn = grab(/能量消耗（估算）[:：]\s*([0-9]+)\s*kcal/);
      const intakeAt = [];
      const tm = cal.match(/timeline[:：]\s*([\s\S]+)$/);
      if (tm) for (const seg of tm[1].split(/[,，]/)) {
        const m = seg.trim().match(/(\d{2}:\d{2})[:：]\s*([0-9]+-[0-9]+)/);
        if (m) intakeAt.push([m[1], m[2]]);
      }
      // 事件流：11-23 11:34 描述 (+698 kcal)
      const events = [];
      for (const seg of String(d0.events || "").split(/[;；]\s*/)) {
        const m = seg.trim().match(/^(\d{2}-\d{2})\s+(\d{2}:\d{2})\s+([\s\S]*?)\s*\(([+-]?\d+)\s*kcal\)$/);
        if (m) events.push({ d: m[1], t: m[2], x: m[3], k: +m[4] });
      }
      // 饮食回顾：概览 / 洞察 / 建议
      const diet = [];
      for (const seg of String(d0.dietary_review || "").split(/[;；]\s*/)) {
        const m = seg.trim().match(/^(概览|洞察|建议)[:：]\s*([\s\S]+)$/);
        if (m) diet.push({ t: m[1], x: m[2].replace(/\*\*/g, "").trim() });
      }
      health = {
        insight: mdLite(d0.summary || ""),
        intake, mid, burn, intakeAt,
        metrics: String(d0.daily_metrics || "").replace(/\*\*/g, "").trim(),
        diet, events,
        range: esc(d0.time_range || ""),
      };
    }
  } catch { /* 没有就算了 */ }

  // 每日总结（平台生成，通常隔天才有）：是一串「时间, 地点, 描述」拼成的长段落，按时间切成小段
  let summary = "", sumSegs = [];
  try {
    const ss = await paged("/summaries", { type: "daily", start_date: day, end_date: day });
    const s0 = ss[0];
    const raw = String(s0?.summary || s0?.content || "").trim();
    if (raw) {
      const marks = [...raw.matchAll(/(\d{2}:\d{2})-(\d{2}:\d{2})\s*[,，]\s*/g)];
      if (marks.length >= 2) {
        for (let i = 0; i < marks.length; i++) {
          const st = marks[i].index + marks[i][0].length;
          const en = i + 1 < marks.length ? marks[i + 1].index : raw.length;
          let body = raw.slice(st, en).replace(/[\s,，]+$/, "");
          const ci = body.indexOf("，") >= 0 ? body.indexOf("，") : body.indexOf(",");
          let place = ci > 0 ? body.slice(0, ci).trim() : "";
          let desc = ci > 0 ? body.slice(ci + 1).trim() : body.trim();
          if (place.length > 18) { desc = body.trim(); place = ""; }
          sumSegs.push({ a: marks[i][1], b: marks[i][2], place, desc: esc(clip(desc, 260)) });
        }
        summary = esc(clip(raw, 2000));
      } else summary = esc(clip(raw, 900));
    }
  } catch { /* 没有就算了 */ }

  // 和 Looki 说的对话摘要（chat 类型，最多 7 天窗口）
  let chat = "";
  try {
    const cs = await paged("/summaries", { type: "chat", start_date: day, end_date: day });
    const c0 = cs[0];
    if (c0) chat = esc(clip(c0.summary || c0.content || "", 600));
  } catch { /* 没有就算了 */ }

  const items = [];
  for (const m of ms) {
    const url = m.cover_file?.thumbnail?.temporary_url;
    let img = normPair(prev.get(m.id), PASS);
    if (!img && url) {
      const raw = await fetchBuf(url);
      if (raw) img = imgPair(raw, PASS);
    }

    items.push({
      id: m.id,
      s: minutesOf(m.start_time), e: (minutesOf(m.end_time) <= minutesOf(m.start_time) ? minutesOf(m.end_time) + 1440 : minutesOf(m.end_time)),
      t: `${hhmm(m.start_time)}–${hhmm(m.end_time)}`,
      title: esc(m.title || "未命名片段"),
      desc: esc(clip(m.description, 700)),
      tags: tagsOf(m.search_context).map(esc),
      loc: esc(coarse(m.cover_file?.location || m.location)),
      img: img?.img || "",
      full: img?.full || "",
      lq: img?.lq || "",
      w: img?.w || 0,
      h: img?.h || 0,
    });
  }

  if (!items.length && !journal && !summary && !comic && !vlog && !recap && !health) return null;

  if (journal && !journal.img) {
    const jp = normPair(prev.get("journal:" + day), PASS) || (journal._url ? await imgFile(journal._url, PASS) : null);
    journal.img = jp?.img || "";
    journal.full = jp?.full || "";
    journal.lq = jp?.lq || ""; journal.w = jp?.w || 0; journal.h = jp?.h || 0;
  }
  if (journal) delete journal._url;

  // 漫画 / vlog 走外置加密文件（页面按需取，不塞进 HTML）
  if (comic) {
    const m = comic._url ? await buildMedia(day, "comic", comic._url, PASS, { maxW: 720, q: 55 }) : null;
    comic.src = m?.p || "";
    comic.full = comic.src;   // 漫画/插画本身就是成品大图，点开即用缓存，不额外下载
    comic.lq = m?.lq || ""; comic.w = m?.w || 0; comic.h = m?.h || 0;
  }
  if (comic) delete comic._url;
  if (vlog) {
    if (vlog._poster) {
      const pm = await buildMedia(day, "vlog-poster", vlog._poster, PASS);
      vlog.poster = pm?.p || "";
    }
    const vm = vlog._url ? await buildMedia(day, "vlog", vlog._url, PASS, { video: true }) : null;
    vlog.src = vm?.p || "";
  }
  if (vlog) { delete vlog._url; delete vlog._poster; }

  const total = items.reduce((s, i) => s + Math.max(0, i.e - i.s), 0);
  const places = [...new Set(items.map(i => i.loc).filter(Boolean))];
  const sub = [
    items.length ? `${items.length} 段记录` : "",
    total ? `共 ${durLabel(total)}` : "",
    places.length ? places.join(" / ") : "",
  ].filter(Boolean).join(" · ") || "这天没有记录";

  return {
    date: day, wd: wdOf(day), generatedAt: new Date().toISOString(),
    count: items.length, sub, summary, sumSegs, chat, journal,
    comic, vlog, recap, health,
    bars: items.map(i => [i.s, i.e]).filter(b => b[1] > b[0]),
    items,
  };
}

import { execFileSync, spawnSync } from "node:child_process";

const REPO = process.env.SHARE_REPO || "2130391838/looki-today";
const PUBLISH = argv.includes("--publish");

function gh(args, input) {
  return execFileSync(process.env.GH_BIN || "gh", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function repoFileSha(rel) {
  try { return gh(["api", `repos/${REPO}/contents/${rel}`, "--jq", ".sha"]); }
  catch { return ""; }
}
function publishFile(rel, file, msg) {
  // 409 是并发写冲突（云端另一轮正在推同一个文件），网络超时/5xx 也要重试 ——
  // 以前只重试 409，一次 i/o timeout 就永久丢掉一张图，页面从此指着 404。
  const soft = (t) => /(409|does not match|timeout|timed out|i\/o|ECONN|EAI_AGAIN|502|503|504|secondary rate)/i.test(t);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const sha = repoFileSha(rel);
    const body = JSON.stringify({ message: msg, content: fs.readFileSync(file).toString("base64"), ...(sha ? { sha } : {}) });
    try {
      gh(["api", "-X", "PUT", `repos/${REPO}/contents/${rel}`, "--input", "-"], body);
      console.log(`   ↑ ${rel}`);
      return true;
    } catch (e) {
      const out = String(e.stderr || e.message);
      if (soft(out) && attempt < 5) {
        const wait = attempt * 1500;
        console.error(`   ! ${rel} 失败（${out.split("\n")[0].slice(0, 70)}），${wait}ms 后重试 ${attempt}/5`);
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait); } catch { }
        continue;
      }
      console.error(`   ✗ ${rel}：${out.split("\n")[0]}`); return false;
    }
  }
  return false;
}
function publishDelete(rel) {
  try {
    const sha = repoFileSha(rel);
    if (!sha) return;
    gh(["api", "-X", "DELETE", `repos/${REPO}/contents/${rel}`, "--input", "-"], JSON.stringify({ message: `remove ${rel}`, sha }));
    console.log(`   🗑 ${rel}`);
  } catch (e) { console.error(`   ✗ 删除 ${rel}：${String(e.stderr || e.message).split("\n")[0]}`); }
}
function repoImgs() {
  try { return JSON.parse(gh(["api", `repos/${REPO}/contents/${IMG_DIR}`, "--jq", "[.[].name]"])); }
  catch { return []; }
}
function repoMedia() {
  try { return JSON.parse(gh(["api", `repos/${REPO}/contents/m`, "--jq", "[.[].name]"])); }
  catch { return []; }
}
function repoDayPages() {
  try {
    return JSON.parse(gh(["api", `repos/${REPO}/contents/d`, "--jq", "[.[].name]"]));
  } catch { return []; }
}

async function main() {
  const now = ymd(new Date());
  const base = new Date(`${now}T12:00:00+08:00`);
  const days = [];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(base); d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const targets = ONLY ? [ONLY] : days;
  const built = [];
  const FULL = argv.includes("--full");   // 强制全部重抓
  // 增量：今天和昨天要抓（还在长数据），更早的日子已经定稿，直接复用已生成的页面，不再打 Looki 接口
  const fresh = new Set(days.slice(0, 3));   // 今天/昨天/前天：健康报告次日 11:28 才出，留一天缓冲
  for (const day of targets) {
    const file = path.join(OUT, "d", `${day}.html`);
    if (!FULL && targets === days && !fresh.has(day)) {
      const old = prevPayload(file, PASS);
      if (old) {
        upgradeImgs(old);
        const bad = validDay(old);
        if (!bad.length) {
          process.stderr.write(`复用 ${day}（已定稿且自检通过，不调接口）\n`);
          built.push(old); continue;
        }
        process.stderr.write(` ${day} 自检不通过（${bad.slice(0, 3).join(", ")}${bad.length > 3 ? " …" : ""}），重抓修复\n`);
      }
    }
    process.stderr.write(`抓取 ${day} … `);
    let p;
    try { p = await buildDay(day, prevImages(file, PASS)); }
    catch (e) { process.stderr.write(`失败，跳过（${e.message}）\n`); continue; }
    process.stderr.write(p ? `${p.count} 段${p.journal ? " +插画" : ""}${p.comic ? " +漫画" : ""}${p.vlog ? " +vlog" : ""}${p.recap ? " +回顾" : ""}${p.health ? " +健康" : ""}\n` : "无记录\n");
    if (p) built.push(p);
  }
  if (!built.length) { console.error("最近 N 天都没有数据，未生成页面"); process.exit(0); }

  const dates = [...new Set(built.map(b => b.date))].sort().reverse();
  const allDates = [...days].sort().reverse();   // 窗口内 7 天全部列出，没内容的置灰但占位
  fs.mkdirSync(path.join(OUT, "d"), { recursive: true });
  let bytes = 0;
  const prevKeys = {};
  // 外壳指纹写进 payload：这样改了 CSS/JS 后旧页一定重写（pageSig 两侧前缀相同会互相抵消）
  for (const p of built) p.shell = shellKey();
  for (const p of built) {
    const f = path.join(OUT, "d", `${p.date}.html`);
    const old = prevPayload(f, PASS);
    prevKeys[p.date] = old ? pageSig(old) : null;
    if (old && prevKeys[p.date] === pageSig(p)) { console.error(`  = ${p.date} 内容没变，不重写`); continue; }
    const html = htmlPage({ ct: encPage(p, PASS), days: allDates, have: dates, day: p.date, title: `${p.date} ${wdOf(p.date)}`, builtAt: builtLabel(p) });
    fs.writeFileSync(f, html); bytes += html.length;
  }
  const latest = dates[0];
  const top = built.find(b => b.date === latest);

  // 本周概览（只加到 index）
  {
    const segs = built.reduce((s, b) => s + b.count, 0);
    const mins = built.reduce((s, b) => s + b.items.reduce((t, i) => t + Math.max(0, i.e - i.s), 0), 0);
    const placeCount = new Map();
    for (const b of built) for (const i of b.items) if (i.loc) placeCount.set(i.loc, (placeCount.get(i.loc) || 0) + 1);
    const place = [...placeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    top.week = {
      win: DAYS, days: built.length, segs,
      hours: (mins / 60).toFixed(1).replace(/\.0$/, ""),
      place,
      head: `${built.length} 天有记录 · 共 ${(mins / 60).toFixed(1).replace(/\.0$/, "")} 小时`,
    };
  }
  const topFile = path.join(OUT, "index.html");
  // 封面：介绍 + 最近 N 天清单（点哪天看哪天）
  {
    const heroPick = (() => {
      if (top.journal && top.journal.img) return { rel: top.journal.img, lq: top.journal.lq, w: top.journal.w, h: top.journal.h };
      if (top.comic && top.comic.src) return { rel: top.comic.src, lq: top.comic.lq, w: top.comic.w, h: top.comic.h };
      const it = (top.items || []).find(i => i.img);
      if (it) return { rel: it.img, lq: it.lq, w: it.w, h: it.h };
      return null;
    })();
    // 封面轮播：7 天里挑最有画面感的几张（插画 / 漫画 / 每天第一张片段图），最多 7 张
    const slides = [];
    const seen = new Set();
    const pushSlide = (rel, lq) => {
      if (!rel || seen.has(rel) || slides.length >= 7) return;
      seen.add(rel); slides.push({ rel, lq: lq || "" });
    };
    for (const b of built) if (b.journal && b.journal.img) pushSlide(b.journal.img, b.journal.lq);
    for (const b of built) if (b.comic && b.comic.src) pushSlide(b.comic.src, b.comic.lq);
    for (const b of built) { const it = (b.items || []).find(i => i.img); if (it) pushSlide(it.img, it.lq); }
    const byDate = new Map(built.map(b => [b.date, b]));
    const list = days.map(d => {                       // 一整周都要列出来，没记录的标「没有记录」
      const b = byDate.get(d);
      const m = b ? (b.items || []).reduce((t, i) => t + Math.max(0, i.e - i.s), 0) : 0;
      return { d, md: d.slice(5).replace("-", "/"), w: wdOf(d), n: b ? b.count : 0,
        sub: b && b.count ? `共 ${durLabel(m)}` : "没有记录" };
    });
    top.cover = {
      title: "我的 Looki 记录",
      sub: `最近 ${DAYS} 天的片段、影像、健康，都在这一个链接里`,
      kind: "口令保护 · 只在你的设备上解密",
      today: `${latest.slice(5).replace("-", "/")} ${wdOf(latest)}`,
      win: DAYS, days: built.length, segs: top.week.segs, hours: top.week.hours,
      hero: heroPick ? heroPick.rel : "", heroLq: heroPick ? (heroPick.lq || "") : "",
      heroW: heroPick ? (heroPick.w || 0) : 0, heroH: heroPick ? (heroPick.h || 0) : 0,
      slides, list,
    };
  }
  const oldTop = prevPayload(topFile, PASS);
  if (!(oldTop && generationsEqual(oldTop, top))) {
    const htmlTop = htmlPage({ ct: encPage(top, PASS), days: allDates, have: dates, day: latest, title: `${latest} ${wdOf(latest)}`, builtAt: builtLabel(top) });
    fs.writeFileSync(topFile, htmlTop);
  }
  fs.writeFileSync(path.join(OUT, "robots.txt"), "User-agent: *\nDisallow: /\n");

  // 状态文件：内容没变也要记「最后检查过」，页面靠它显示新鲜度（不靠页面内的时间戳）
  const sigs = {};
  for (const b of built) {
    const rels = [b.journal?.img, b.journal?.full, b.comic?.src, b.comic?.full, ...(b.items || []).flatMap(i => [i.img, i.full])].filter(Boolean);
    sigs[b.date] = crypto.createHash("sha1").update(rels.join("|")).digest("hex").slice(0, 12);
  }
  fs.writeFileSync(path.join(OUT, "m/status.json"), JSON.stringify({
    checkedAt: new Date().toISOString(),
    contentDays: dates,
    sigs,
  }));

  // 媒体清单（幂等指纹）：云端下次跑可直接复用，不重下不重压
  fs.mkdirSync(path.join(OUT, "m"), { recursive: true });
  const keepDays = new Set(dates);
  for (const d of Object.keys(MANIFEST)) if (!keepDays.has(d)) delete MANIFEST[d];
  fs.writeFileSync(path.join(OUT, "m/manifest.json"), JSON.stringify(MANIFEST, null, 0));
  const keepRel = new Set();
  for (const d of Object.keys(MANIFEST)) for (const k of Object.keys(MANIFEST[d])) {
    const r = MANIFEST[d][k]?.rel;
    if (r) keepRel.add(r.slice(2));
  }
  for (const f of fs.readdirSync(path.join(OUT, "m"))) {
    if (!/\.(bin|mp4|webp)$/.test(f)) continue;
    if (!keepDays.has(f.slice(0, 10)) || !keepRel.has(f)) { fs.unlinkSync(path.join(OUT, "m", f)); console.log(`🗑  删除过期媒体：${f}`); }
  }

  // 图片：按当前 7 天窗口的引用剪枝（内容寻址，同名即复用）
  {
    const used = new Set();
    const addRel = (r) => { if (r && r.startsWith(IMG_DIR + "/")) used.add(path.basename(r)); };
    for (const b of built) {
      addRel(b.journal?.img); addRel(b.journal?.full);
      if (b.comic) { addRel(b.comic.src); addRel(b.comic.full); }
      for (const i of b.items) { addRel(i.img); addRel(i.full); }
    }
    const dir = path.join(OUT, IMG_DIR);
    if (fs.existsSync(dir)) {
      let n = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!/\.(webp|bin)$/.test(f)) continue;   // 之前只扫 .bin，而实际文件是 .webp，剪枝一直没生效
        if (!used.has(f)) { fs.unlinkSync(path.join(dir, f)); n++; }
      }
      if (n) console.log(`🗑  删除未引用图片：${n} 张`);
    }
  }

  // 只保留窗口内的日期页，更早的删掉
  const keep = new Set(dates);
  for (const f of fs.readdirSync(path.join(OUT, "d"))) {
    const d = f.replace(/\.html$/, "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !keep.has(d)) {
      fs.unlinkSync(path.join(OUT, "d", f));
      console.log(`🗑  删除过期页：${f}`);
    }
  }

  console.log(`✅ ${OUT}`);
  console.log(`   天数：${dates.length}（${dates.join(", ")}）`);
  console.log(`   片段：${built.reduce((s, b) => s + b.count, 0)} 段 · 日记 ${built.filter(b => b.journal).length} 篇`);
  console.log(PASS_FROM_ENV ? "   口令：来自 SHARE_PASS（不打印）" : `   口令：${PASS}`);

  const badDays = new Set();   // 图/媒体没上全的日子，这一轮不推它的页面
  if (PUBLISH) {
    console.log(`🚀 发布到 ${REPO}`);
    publishFile("build/share.mjs", process.argv[1], "builder");
    const verPath = path.join(path.dirname(process.argv[1]), "verify-refs.js");
    if (fs.existsSync(verPath)) publishFile("build/verify-refs.js", verPath, "verify-refs");
    publishFile("robots.txt", path.join(OUT, "robots.txt"), "robots");
    // 本机没有 ffmpeg 时**不要**上传媒体与清单：否则会把云端压好的小文件覆盖成原件（1.5MB 漫画、7MB vlog），
    // 而且清单里的指纹会让云端误判"已经处理过"而跳过压缩。媒体交给云端跑。
    if (HAVE_FFMPEG) {
      publishFile("m/manifest.json", path.join(OUT, "m/manifest.json"), "manifest");
      const mdir = path.join(OUT, "m");
      const localM = fs.readdirSync(mdir).filter(f => /\.(bin|mp4|webp)$/.test(f)).sort();
      for (const f of localM) publishFile(`m/${f}`, path.join(mdir, f), `media ${f}`);
      // 媒体也要核一遍：漫画/vlog 是一整块，缺了用户点开就是一片黑
      const mMiss = localM.filter((f) => !new Set(repoMedia()).has(f));
      for (let t = 1; t <= 3 && mMiss.length; t++) {
        console.error(`   ! 远端缺媒体 ${mMiss.length} 个，补传 ${t}/3`);
        for (const f of mMiss) publishFile(`m/${f}`, path.join(mdir, f), `media ${f} retry${t}`);
        const nowM = new Set(repoMedia());
        mMiss.splice(0, mMiss.length, ...mMiss.filter((f) => !nowM.has(f)));
      }
      if (mMiss.length) {
        console.error(`   ✗ 媒体仍缺 ${mMiss.length} 个：${mMiss.join(", ")}`);
        for (const b of built) {
          const rels = [b.comic?.src, b.vlog?.poster, b.vlog?.src].filter(Boolean);
          if (rels.some((r) => mMiss.includes(path.basename(r)))) badDays.add(b.date);
        }
      }
      // 远端过期媒体（换名后旧的、7 天窗外的）要删掉，否则仓库只涨不减
      const keepM = new Set(localM);
      for (const name of repoMedia()) {
        if (!/\.(bin|mp4|webp)$/.test(name)) continue;
        if (!keepM.has(name)) publishDelete(`m/${name}`);
      }
    } else {
      console.log("   媒体：本机没有 ffmpeg，跳过 m/*.bin 与 manifest（交给云端处理）");
    }
    const imgDir = path.join(OUT, IMG_DIR);
    if (fs.existsSync(imgDir)) {
      const remote = new Set(repoImgs());
      let up = 0;
      for (const f of fs.readdirSync(imgDir).sort()) {
        if (!/\.(bin|webp|jpg)$/.test(f)) continue;
        if (remote.has(f)) continue;
        publishFile(`${IMG_DIR}/${f}`, path.join(imgDir, f), `img ${f}`);
        up++;
      }
      console.log(`   ↑ 新图 ${up} 张（已有 ${remote.size} 张跳过）`);
      for (const name of remote) {
        if (!fs.existsSync(path.join(imgDir, name))) publishDelete(`${IMG_DIR}/${name}`);
      }

      // 上传后再核一遍：页面会引用哪些图，远端就必须真的有。少一张就补传；
      // 补不上就这一轮不推那几页 —— 宁可晚一轮，也不能让页面指着 404 的高清图。
      const need = new Set();
      const addNeed = (r) => { if (r && r.startsWith(IMG_DIR + "/")) need.add(path.basename(r)); };
      for (const b of built) {
        addNeed(b.journal?.img); addNeed(b.journal?.full);
        if (b.comic) { addNeed(b.comic.src); addNeed(b.comic.full); }
        for (const i of b.items) { addNeed(i.img); addNeed(i.full); }
      }
      let missing = [...need].filter((f) => !new Set(repoImgs()).has(f));
      for (let t = 1; t <= 3 && missing.length; t++) {
        console.error(`   ! 远端缺 ${missing.length} 张，补传 ${t}/3：${missing.slice(0, 3).join(", ")}`);
        for (const f of missing) publishFile(`${IMG_DIR}/${f}`, path.join(imgDir, f), `img ${f} retry${t}`);
        const now2 = new Set(repoImgs());
        missing = missing.filter((f) => !now2.has(f));
      }
      if (missing.length) {
        const bad = new Set(missing);
        for (const b of built) {
          const rels = [b.journal?.img, b.journal?.full, b.comic?.src, b.comic?.full,
            ...(b.items || []).flatMap((i) => [i.img, i.full])].filter(Boolean);
          if (rels.some((r) => bad.has(path.basename(r)))) badDays.add(b.date);
        }
        console.error(`   ✗ 仍缺 ${missing.length} 张，跳过这些天的页面：${[...badDays].join(", ") || "（无）"}`);
      }
    }
    for (const d of dates) {
      if (badDays.has(d)) { console.error(`   - 跳过 d/${d}.html（图没上全）`); continue; }
      publishFile(`d/${d}.html`, path.join(OUT, "d", `${d}.html`), `day ${d}`);
    }
    if (!badDays.has(latest)) publishFile("index.html", path.join(OUT, "index.html"), `index`);
    // status.json 里的 sigs 是「新数据的签名」，必须**在页面推完之后**再推：
    // 先推它会让客户端拿着新签名去比旧页面，白丢缓存重下一趟。
    if (badDays.size) {
      console.error(`   - 有 ${badDays.size} 天没推全，跳过 status.json（避免缓存签名和页面不一致）`);
    } else if (fs.existsSync(path.join(OUT, "m/status.json"))) {
      publishFile("m/status.json", path.join(OUT, "m/status.json"), "status");
    }
    for (const name of repoDayPages()) {
      if (!/^\d{4}-\d{2}-\d{2}\.html$/.test(name)) continue;
      if (keep.has(name.replace(/\.html$/, ""))) continue;
      publishDelete(`d/${name}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });