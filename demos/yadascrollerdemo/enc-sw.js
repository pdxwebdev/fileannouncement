const HEADER = 28;
const keys = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "YADA_ENC_KEYS") return;
  const bag = data.keys || {};
  Object.keys(bag).forEach((id) => {
    if (bag[id]) keys.set(id, bag[id]);
  });
});

function b64ToBytes(value) {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function counterAt(iv, blocks) {
  const c = new Uint8Array(iv);
  const view = new DataView(c.buffer);
  const base = (BigInt(view.getUint32(8)) << 32n) + BigInt(view.getUint32(12));
  const next = base + BigInt(blocks);
  view.setUint32(8, Number((next >> 32n) & 0xffffffffn));
  view.setUint32(12, Number(next & 0xffffffffn));
  return c;
}

async function cipherMeta(url) {
  const res = await fetch(url, {
    headers: { Range: "bytes=0-27" },
    credentials: "same-origin",
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== "YADAENC1" || bytes.length < HEADER) {
    throw new Error("not a sealed object");
  }
  const range = res.headers.get("Content-Range") || "";
  const total = Number((range.split("/")[1] || "0").trim());
  if (!total) throw new Error("missing ciphertext length");
  return { iv: bytes.subarray(12, 28), total };
}

function parseRange(header, total) {
  if (!header || !header.startsWith("bytes=")) return [0, total - 1];
  const part = header.slice(6).split(",")[0];
  const bits = part.split("-");
  let start = bits[0] === "" ? NaN : Number(bits[0]);
  let end = bits[1] === "" ? total - 1 : Number(bits[1]);
  if (Number.isNaN(start)) start = Math.max(0, total - end);
  if (Number.isNaN(end) || end >= total) end = total - 1;
  if (start < 0 || start > end) return null;
  return [start, end];
}

async function decryptRange(request, fileId) {
  const url = request.url.split("?")[0];
  const meta = await cipherMeta(url);
  const plainTotal = meta.total - HEADER;
  const span = parseRange(request.headers.get("Range"), plainTotal);
  if (!span) {
    return new Response("range not satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${plainTotal}` },
    });
  }
  const [start, end] = span;
  const aligned = start - (start % 16);
  const res = await fetch(url, {
    headers: { Range: `bytes=${HEADER + aligned}-${HEADER + end}` },
    credentials: "same-origin",
  });
  if (!(res.ok || res.status === 206)) {
    return new Response("ciphertext unavailable", { status: res.status });
  }
  const ct = new Uint8Array(await res.arrayBuffer());
  const raw = b64ToBytes(keys.get(fileId));
  const cryptoKey = await crypto.subtle.importKey("raw", raw, "AES-CTR", false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-CTR", counter: counterAt(meta.iv, aligned / 16), length: 64 },
      cryptoKey,
      ct
    )
  );
  const slice = plain.subarray(start - aligned);
  const type = new URL(request.url).searchParams.get("mime_type") || res.headers.get("Content-Type") || "application/octet-stream";
  return new Response(slice, {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(slice.length),
      "Content-Range": `bytes ${start}-${end}/${plainTotal}`,
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/\/file-announcements\/api\/v1\/public\/stream\/[^/]+\/([^/]+)/);
  if (!match || event.request.method !== "GET") return;
  const fileId = decodeURIComponent(match[1]);
  if (!keys.has(fileId)) return;
  event.respondWith(decryptRange(event.request, fileId));
});
