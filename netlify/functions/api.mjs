// 邮箱服务端（Netlify Functions 版）
// 一个函数处理全部接口，存储用 Netlify Blobs。
// 本地测试时设置 MEMORY_STORE=1 会用内存代替 Blobs。

const MAIL_ADMIN_TOKEN = process.env.MAIL_ADMIN_TOKEN || "";
const MEMORY = process.env.MEMORY_STORE === "1";

// ---------------------------------------------------------------- 存储
const memory = new Map();

const memoryStore = {
  async get(key, opts) {
    const v = memory.get(key);
    if (v === undefined) return null;
    return opts && opts.type === "json" ? JSON.parse(v) : v;
  },
  async setJSON(key, value) {
    memory.set(key, JSON.stringify(value));
  },
  async delete(key) {
    memory.delete(key);
  },
  async list(opts) {
    const prefix = (opts && opts.prefix) || "";
    const blobs = [...memory.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k }));
    return { blobs };
  },
};

async function store() {
  if (MEMORY) return memoryStore;

  // 绝对不能缓存这个 store 对象：
  // 它是带着「本次调用」的 Blobs 令牌创建的，而令牌会过期。
  // 一旦缓存下来，热实例下次复用就会报 Failed to decode token: Token expired。
  // 每次请求重新取一次，开销可以忽略。
  const { getStore } = await import("@netlify/blobs");

  // Lambda 兼容模式没有 uncachedEdgeURL，只能用默认（eventual）一致性；
  // 强一致性会抛 BlobsConsistencyError。
  return getStore({ name: "mail" });
}

async function getJSON(key) {
  const s = await store();
  return s.get(key, { type: "json" });
}

async function setJSON(key, value) {
  const s = await store();
  await s.setJSON(key, value);
}

// ---------------------------------------------------------------- 工具
const now = () => Math.floor(Date.now() / 1000);

function makeId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function html(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
  };
}

function fail(status, error, detail) {
  return json(status, { ok: false, error, detail: detail || error });
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf-8")
    : event.body;
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value ? value : {};
  } catch (e) {
    return {};
  }
}

function header(event, name) {
  const headers = event.headers || {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return headers[key];
  }
  return "";
}

function version(text) {
  const parts = String(text || "0")
    .split(".")
    .map((p) => parseInt(p.replace(/[^0-9]/g, ""), 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function audienceOk(audience, player) {
  if (!audience || !Object.keys(audience).length) return true;
  if (audience.platform && player.platform &&
      audience.platform.toLowerCase() !== String(player.platform).toLowerCase()) {
    return false;
  }
  const v = version(player.game_version);
  const min = version(audience.min_version);
  const max = version(audience.max_version);
  for (let i = 0; i < 3; i += 1) {
    if (audience.min_version && v[i] < min[i]) return false;
    if (audience.min_version && v[i] > min[i]) break;
  }
  for (let i = 0; i < 3; i += 1) {
    if (audience.max_version && v[i] > max[i]) return false;
    if (audience.max_version && v[i] < max[i]) break;
  }
  return true;
}

function preview(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

// ---------------------------------------------------------------- 认证
async function requirePlayer(event) {
  const auth = header(event, "authorization");
  if (!auth.toLowerCase().startsWith("bearer ")) {
    throw { status: 401, code: "missing_token" };
  }
  const token = auth.slice(7).trim();
  const device = await getJSON("token:" + token);
  if (!device) throw { status: 401, code: "invalid_token" };
  const player = await getJSON("player:" + device);
  if (!player) throw { status: 401, code: "invalid_token" };
  player.last_seen = now();
  await setJSON("player:" + device, player);
  return player;
}

function requireAdmin(event) {
  const token = header(event, "x-admin-token") ||
    (header(event, "authorization").toLowerCase().startsWith("bearer ")
      ? header(event, "authorization").slice(7).trim() : "");
  if (!MAIL_ADMIN_TOKEN || token !== MAIL_ADMIN_TOKEN) {
    throw { status: 401, code: "admin_token_invalid" };
  }
}

// ---------------------------------------------------------------- 邮件索引
async function readIndex() {
  return (await getJSON("index")) || [];
}

async function loadActiveMails(player) {
  const index = await readIndex();
  const ts = now();
  const result = [];
  for (const item of index) {
    if (item.revoked) continue;
    if (item.published_at > ts) continue;
    if (item.expires_at && item.expires_at <= ts) continue;
    if (!audienceOk(item.audience, player)) continue;
    result.push(item);
  }
  result.sort((a, b) => b.published_at - a.published_at || b.id - a.id);
  return result;
}

async function loadAllMails() {
  // /mails 页面要看到「全部已发布」，所以不按版本/平台过滤
  const index = await readIndex();
  const ts = now();
  return index
    .filter((m) => !m.revoked && m.published_at <= ts && (!m.expires_at || m.expires_at > ts))
    .sort((a, b) => b.published_at - a.published_at || b.id - a.id);
}

async function receiptsOf(device) {
  const s = await store();
  const { blobs } = await s.list({ prefix: "receipt:" + device + ":" });
  const map = {};
  for (const blob of blobs) {
    const record = await getJSON(blob.key);
    if (record) map[String(record.mail_id)] = record;
  }
  return map;
}

async function receiptKey(device, mailId) {
  return "receipt:" + device + ":" + mailId;
}

// ---------------------------------------------------------------- 统计
async function receiptStats() {
  const s = await store();
  const reads = {};
  const claims = {};

  let cursor;
  for (;;) {
    const page = await s.list({ prefix: "receipt:", cursor });
    for (const blob of page.blobs) {
      const parts = blob.key.split(":");
      const mailId = parts[parts.length - 1];
      reads[mailId] = (reads[mailId] || 0) + 1;

      const record = await getJSON(blob.key);
      if (record && record.claimed_at) {
        claims[mailId] = (claims[mailId] || 0) + 1;
      }
    }
    cursor = page.cursor;
    if (!cursor) break;
  }

  return { reads, claims };
}

// ---------------------------------------------------------------- 页面
function esc(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function blocksHtml(mail, lazy) {
  const blocks = mail.layout || [];
  const parts = [];
  if (blocks.length) {
    for (const b of blocks) {
      if (b.type === "text") {
        parts.push('<div style="font-size:' + (b.size || 19) + "px;color:" +
          esc(b.color || "#33373f") + ";text-align:" + esc(b.align || "left") +
          ';white-space:pre-wrap;margin:0 0 10px">' + esc(b.text || "") + "</div>");
      } else if (b.type === "image" && String(b.data || "").startsWith("data:image/")) {
        const margin = { left: "0 auto 0 0", right: "0 0 0 auto" }[b.align] || "0 auto";
        parts.push('<img ' + (lazy ? 'loading="lazy" ' : "") + 'src="' + esc(b.data) +
          '" style="display:block;width:' + (b.w || 320) + "px;margin:" + margin +
          ' 0 10px;border-radius:4px">');
      } else if (b.type === "space") {
        parts.push('<div style="height:' + (b.h || 40) + 'px"></div>');
      }
    }
  } else {
    parts.push('<div style="font-size:18px;color:#33373f;white-space:pre-wrap">' +
      esc(mail.body || "") + "</div>");
  }
  return parts.join("");
}

function attachmentsHtml(mail) {
  const list = mail.attachments || [];
  if (!list.length) return "";
  return '<div style="margin-top:18px;font-size:16px;color:#33373f">附件：' +
    list.map((a) => esc(a.name || a.id) + " ×" + (a.count || 1)).join("、") + "</div>";
}

const PAGE_CSS = `
  body{margin:0;background:#f6f3ec;font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#2f333d}
  .wrap{max-width:760px;margin:36px auto;padding:0 16px}
  .mail{background:#fffdf8;border-radius:12px;padding:26px 30px;margin-bottom:18px;box-shadow:0 6px 24px rgba(0,0,0,.06)}
  h1{font-size:24px;margin:0 0 4px}h2{font-size:20px;margin:0 0 4px}
  .meta{font-size:13px;color:#7b7f8a;margin-bottom:18px}
  .flag{font-size:12px;color:#c0392b;border:1px solid #e6b0aa;border-radius:10px;padding:1px 8px;margin-left:6px}
  .back{display:inline-block;margin:6px 0 18px;color:#7b7f8a;font-size:13px;text-decoration:none}

  .wrap.wide{max-width:1420px}
  .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start;margin-top:6px}
  .grid .mail{margin-bottom:0}

  .mail details summary{display:block;cursor:pointer;list-style:none}
  .mail .row1{display:flex;align-items:center;gap:8px}
  .mail details summary::-webkit-details-marker{display:none}
  .mail .tt{font-size:18px;font-weight:600;color:#22262e;word-break:break-all}
  .mail .arrow{margin-left:auto;color:#b9bcc4;font-size:12px;transition:transform .15s}
  .mail details[open] .arrow{transform:rotate(90deg)}
  .mail .meta{margin:6px 0 0;line-height:1.5}
  .mail .body{margin-top:14px;font-size:15px}

  @media (max-width:1200px){ .grid{grid-template-columns:repeat(2,minmax(0,1fr))} }
  @media (max-width:760px){ .grid{grid-template-columns:1fr;gap:10px} }

  .mail[data-revoked]{opacity:.72}
  .retract{display:block;margin:18px 0 0 auto;background:transparent;border:1px solid #e0b4ae;
           color:#c0392b;border-radius:8px;padding:5px 16px;font-size:13px;cursor:pointer}
  .retract:hover{background:#fdf3f2}
  .retract[disabled]{opacity:.5;cursor:default}
  .topbar{display:flex;align-items:center;gap:12px;margin:6px 0 18px;font-size:13px;color:#7b7f8a}
`;

const RETRACT_SCRIPT = `
<script>
(function () {
  var token = localStorage.getItem("mail_admin_token") || "";
  var buttons = document.querySelectorAll("[data-retract]");

  if (!token) {
    buttons.forEach(function (b) { b.style.display = "none"; });
    return;
  }

  buttons.forEach(function (button) {
    button.addEventListener("click", function (event) {
      event.preventDefault();

      var id = button.getAttribute("data-retract");
      if (!confirm("撤回邮件 #" + id + "？玩家将不再看到它。")) return;

      button.disabled = true;
      button.textContent = "撤回中…";

      fetch("/admin/api/mails/" + id + "/retract", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": token },
        body: "{}"
      }).then(function (response) {
        return response.json();
      }).then(function (data) {
        if (!data.ok) throw new Error(data.detail || data.error || "失败");
        location.reload();
      }).catch(function (error) {
        button.disabled = false;
        button.textContent = "撤回";
        alert("撤回失败：" + error.message);
      });
    });
  });
})();
</script>
`;

function page(title, inner, wide) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + esc(title) + "</title><style>" + PAGE_CSS + "</style></head><body>" +
    '<div class="wrap' + (wide ? " wide" : "") + '">' + inner + "</div></body></html>";
}

function card(mail, collapsible) {
  // 函数跑在 UTC，页面上要显示北京时间
  const time = new Date(mail.published_at * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
  }).replace(/\//g, "-").slice(0, 16);

  const retract = mail.revoked
    ? ""
    : '<button class="retract" type="button" data-retract="' + mail.id + '">撤回</button>';

  const revoked = mail.revoked ? ' data-revoked="1"' : "";
  const flag = mail.revoked ? '<span class="flag">已撤回</span>' : "";
  const minVersion = (mail.audience && mail.audience.min_version) || "";
  const versionTag = minVersion ? minVersion + "+" : "全部版本";

  const meta = '<div class="meta">' + esc(mail.sender || "") + " · " + time +
    " · 已读 " + (mail.read_count || 0) + " · 适用 " + esc(versionTag) +
    " · 邮件 #" + mail.id + "</div>";

  // 单封详情页：直接摊开
  if (!collapsible) {
    return "<article class=\"mail\"" + revoked + "><h1>" + esc(mail.title) + "</h1>" +
      flag + meta + blocksHtml(mail, false) + attachmentsHtml(mail) + "</article>";
  }

  // 列表页：默认折叠，点标题展开
  return "<article class=\"mail\"" + revoked + ">" +
    "<details><summary>" +
    '<div class="row1"><span class="tt">' + esc(mail.title) + "</span>" + flag +
    '<span class="arrow">▸</span></div>' + meta +
    "</summary>" +
    '<div class="body">' + blocksHtml(mail, true) + attachmentsHtml(mail) + "</div>" +
    "</details>" + retract + "</article>";
}

// ---------------------------------------------------------------- 路由
async function route(event) {
  const params = event.queryStringParameters || {};
  const path = params.route || event.path || "/";
  const method = event.httpMethod || "GET";
  const body = parseBody(event);

  // ---------------- 玩家接口 ----------------
  if (path === "/v1/session" && method === "POST") {
    const ts = now();
    let device = String(body.device_id || "").trim();
    let player = null;

    if (device) {
      player = await getJSON("player:" + device);
      if (!player) return fail(409, "unknown_device", "服务端不认识这个设备，请用新 device_id 重试");
      player.last_seen = ts;
      if (body.game_version) player.game_version = String(body.game_version).slice(0, 32);
      if (body.platform) player.platform = String(body.platform).slice(0, 16);
      await setJSON("player:" + device, player);
    } else {
      device = crypto.randomUUID();
      const token = [...crypto.getRandomValues(new Uint8Array(24))]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      player = {
        device_id: device, token, created_at: ts, last_seen: ts,
        game_version: String(body.game_version || "").slice(0, 32),
        platform: String(body.platform || "").slice(0, 16),
      };
      await setJSON("player:" + device, player);
      await setJSON("token:" + token, device);
    }

    // 记下玩家上报的版本，后台用来显示「当前游戏版本」
    if (player.game_version) {
      await setJSON("meta/version", { version: player.game_version, at: ts });
    }

    return json(200, {
      ok: true, device_id: player.device_id, token: player.token, server_time: ts,
    });
  }

  if (path === "/v1/mail" && method === "GET") {
    const player = await requirePlayer(event);
    const mails = await loadActiveMails(player);
    const receipts = await receiptsOf(player.device_id);

    const items = [];
    let unread = 0;
    for (const mail of mails) {
      const receipt = receipts[String(mail.id)];
      const read = Boolean(receipt && receipt.read_at);
      if (!read) unread += 1;
      items.push({
        id: mail.id, title: mail.title, sender: mail.sender,
        published_at: mail.published_at, preview: preview(mail.body),
        has_attachment: (mail.attachments || []).length > 0,
        read, claimed: Boolean(receipt && receipt.claimed_at),
      });
    }
    return json(200, { ok: true, server_time: now(), unread, mails: items });
  }

  const mailMatch = path.match(/^\/v1\/mail\/(\d+)(\/read|\/claim)?$/);
  if (mailMatch) {
    const player = await requirePlayer(event);
    const mail = await getJSON("mail:" + mailMatch[1]);
    if (!mail || mail.revoked) return fail(404, "mail_not_found", "邮件不存在或已撤回");
    if (mail.published_at > now()) return fail(404, "mail_not_found", "邮件还没到发布时间");
    if (mail.expires_at && mail.expires_at <= now()) return fail(404, "mail_not_found", "邮件已过期");
    if (!audienceOk(mail.audience, player)) return fail(404, "mail_not_found", "这封邮件不是发给你的");

    const action = mailMatch[2] || "";

    if (action === "" && method === "GET") {
      return json(200, {
        ok: true, id: mail.id, title: mail.title, sender: mail.sender,
        published_at: mail.published_at, body: mail.body,
        blocks: mail.layout || [], attachments: mail.attachments || [],
      });
    }

    if (action === "/read" && method === "POST") {
      const key = await receiptKey(player.device_id, mail.id);
      const record = (await getJSON(key)) || { mail_id: mail.id, read_at: null, claimed_at: null };
      record.read_at = record.read_at || now();
      await setJSON(key, record);
      return json(200, { ok: true, read_at: record.read_at });
    }

    if (action === "/claim" && method === "POST") {
      const key = await receiptKey(player.device_id, mail.id);
      const record = (await getJSON(key)) || { mail_id: mail.id, read_at: now(), claimed_at: null };
      const first = !record.claimed_at;
      record.claimed_at = record.claimed_at || now();
      record.read_at = record.read_at || now();
      await setJSON(key, record);
      return json(200, {
        ok: true, first, claim_id: crypto.randomUUID(),
        attachments: mail.attachments || [], claimed_at: record.claimed_at,
      });
    }

    return fail(405, "method_not_allowed");
  }

  if (path === "/v1/mail/read_all" && method === "POST") {
    const player = await requirePlayer(event);
    const mails = await loadActiveMails(player);
    const ts = now();
    for (const mail of mails) {
      const key = await receiptKey(player.device_id, mail.id);
      const record = (await getJSON(key)) || { mail_id: mail.id, read_at: null, claimed_at: null };
      record.read_at = record.read_at || ts;
      await setJSON(key, record);
    }
    return json(200, { ok: true, read_at: ts });
  }

  // ---------------- 管理接口 ----------------
  if (path === "/admin/api/stats" && method === "GET") {
    requireAdmin(event);
    const index = await readIndex();
    const s = await store();

    let players = 0;
    let reads = 0;
    try {
      players = (await s.list({ prefix: "player:" })).blobs.length;
      reads = (await s.list({ prefix: "receipt:" })).blobs.length;
    } catch (e) {
      players = 0;
    }

    let gameVersion = "";
    try {
      const meta = await getJSON("meta/version");
      gameVersion = (meta && meta.version) || "";
    } catch (e) {}

    return json(200, {
      ok: true,
      game_version: gameVersion,
      players,
      active7: null,
      mails: index.length,
      live_mails: index.filter((m) => !m.revoked).length,
      reads,
      uptime: 0,
      server_time: now(),
    });
  }

  if (path === "/admin/api/mails" && method === "GET") {
    requireAdmin(event);
    const index = await readIndex();
    const stats = await receiptStats();
    return json(200, {
      ok: true,
      mails: index.map((m) => ({
        id: m.id, title: m.title, sender: m.sender, body: m.body,
        attachments: m.attachments || [], audience: m.audience || {},
        published_at: m.published_at, expires_at: m.expires_at || null,
        revoked: Boolean(m.revoked),
        read_count: stats.reads[String(m.id)] || 0,
        claim_count: stats.claims[String(m.id)] || 0,
      })),
    });
  }

  if (path === "/admin/api/mails" && method === "POST") {
    requireAdmin(event);
    const title = String(body.title || "").trim();
    if (!title) return fail(400, "title_required", "标题不能为空");

    const id = makeId();
    const ts = now();
    const mail = {
      id,
      title: title.slice(0, 120),
      sender: String(body.sender || "运营组").slice(0, 32),
      body: String(body.body || ""),
      layout: Array.isArray(body.blocks) ? body.blocks : [],
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      audience: body.audience && typeof body.audience === "object" ? body.audience : {},
      published_at: body.publish_at ? Math.floor(new Date(body.publish_at).getTime() / 1000) : ts,
      expires_at: body.expires_at ? Math.floor(new Date(body.expires_at).getTime() / 1000) : null,
      revoked: false,
      created_at: ts,
      updated_at: ts,
    };
    if (!Number.isFinite(mail.published_at)) mail.published_at = ts;

    await setJSON("mail:" + id, mail);

    const index = await readIndex();
    index.push({
      id, title: mail.title, sender: mail.sender, body: mail.body,
      attachments: mail.attachments, audience: mail.audience,
      published_at: mail.published_at, expires_at: mail.expires_at,
      revoked: false,
    });
    await setJSON("index", index);

    return json(200, { ok: true, id });
  }

  const adminMatch = path.match(/^\/admin\/api\/mails\/(\d+)\/(retract|delete)$/);
  if (adminMatch) {
    requireAdmin(event);
    const id = adminMatch[1];
    const index = await readIndex();
    const at = index.findIndex((m) => String(m.id) === id);
    if (at < 0) return fail(404, "mail_not_found");

    if (adminMatch[2] === "retract") {
      index[at].revoked = true;
      await setJSON("index", index);
      const mail = await getJSON("mail:" + id);
      if (mail) {
        mail.revoked = true;
        mail.updated_at = now();
        await setJSON("mail:" + id, mail);
      }
      return json(200, { ok: true });
    }

    index.splice(at, 1);
    await setJSON("index", index);
    await (await store()).delete("mail:" + id);
    return json(200, { ok: true });
  }

  // ---------------- 网页版 ----------------
  if (path === "/mails" && method === "GET") {
    const mails = await loadAllMails();
    const index = await readIndex();
    const revoked = index.filter((m) => m.revoked);

    const stats = await receiptStats();

    const withCounts = (m) => ({
      ...m,
      read_count: stats.reads[String(m.id)] || 0,
    });

    const cards = mails.map((m) => card(withCounts(m), true))
      .concat(revoked.map((m) => card(withCounts({ ...m, layout: [], attachments: [] }), true)));

    const topbar = '<div class="topbar"><a class="back" style="margin:0" href="/">← 回到后台</a>' +
      '<span>共 ' + cards.length + " 封</span></div>";

    const body = cards.length
      ? '<div class="grid">' + cards.join("") + "</div>"
      : '<article class="mail"><h2>还没有邮件</h2><div class="meta">在后台发布后会出现在这里</div></article>';

    return html(page("全部邮件", topbar + body + RETRACT_SCRIPT, true));
  }

  const pageMatch = path.match(/^\/mail\/(\d+)$/);
  if (pageMatch && method === "GET") {
    const mail = await getJSON("mail:" + pageMatch[1]);
    if (!mail || mail.revoked || mail.published_at > now()) {
      return { statusCode: 404, headers: { "content-type": "text/html; charset=utf-8" },
        body: "<h1>404</h1><p>邮件不存在或已撤回</p>" };
    }
    return html(page(mail.title, '<a class="back" href="/mails">← 全部邮件</a>' + card(mail)));
  }

  return fail(404, "not_found", "接口不存在：" + path);
}

export async function handler(event) {
  try {
    // Functions v1（Lambda 兼容模式）不会自动注入 Blobs 环境，
    // 必须在第一次 getStore 之前手动连一次，否则会抛 MissingBlobsEnvironmentError。
    if (!MEMORY) {
      try {
        const { connectLambda } = await import("@netlify/blobs");
        if (typeof connectLambda === "function") connectLambda(event);
      } catch (e) {
        // 已经不在 v1 环境时忽略
      }
    }

    return await route(event);
  } catch (error) {
    if (error && error.status) {
      return fail(error.status, error.code, error.code);
    }
    console.error(error);
    return fail(500, "internal_error", String(error));
  }
}
