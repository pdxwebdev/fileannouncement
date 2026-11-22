(function () {
  const INDEXER = "https://sia.storage";
  const APP_ID = "ef771f39d74338072dd10ba7d13c99120659a7e383233d627f7f54727cdd2f6d";
  const KEY = "yada-sia-app-key";
  const appMeta = {
    appId: APP_ID,
    name: "Yada Scroller",
    description: "Comments, likes, and posts",
    serviceUrl: location.origin,
  };

  function hexToBytes(hex) {
    const clean = String(hex || "").trim();
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2) {
      throw new Error("invalid App Key");
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  async function sdkLib() {
    if (!window.__yadaSiaLib) {
      window.__yadaSiaLib = import("https://esm.sh/@siafoundation/sia-storage");
    }
    const lib = await window.__yadaSiaLib;
    if (lib.initSia) await lib.initSia();
    return lib;
  }

  function storedKey() {
    try {
      return localStorage.getItem(KEY) || "";
    } catch (_) {
      return "";
    }
  }

  async function reconnect() {
    const hex = storedKey();
    if (!hex) return null;
    const { Builder, AppKey } = await sdkLib();
    const sdk = await new Builder(INDEXER, appMeta).connected(new AppKey(hexToBytes(hex)));
    return sdk || null;
  }

  async function connect(mnemonic) {
    const phrase = String(mnemonic || "").trim();
    if (!phrase) throw new Error("recovery phrase required");
    const { Builder } = await sdkLib();
    const builder = new Builder(INDEXER, appMeta);
    await builder.requestConnection();
    const url = builder.responseUrl();
    window.open(url, "_blank", "noopener");
    await builder.waitForApproval();
    const sdk = await builder.register(phrase);
    const exported = sdk.appKey().export();
    const hex = exported.toHex ? exported.toHex() : Array.from(exported, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(KEY, hex);
    return sdk;
  }

  async function ensure(mnemonic) {
    const existing = await reconnect();
    if (existing) return existing;
    return connect(mnemonic);
  }

  async function putActivity(kind, payload) {
    const sdk = await reconnect();
    if (!sdk) throw new Error("storage account is not set up");
    const { PinnedObject } = await sdkLib();
    const body = JSON.stringify({ kind: kind, payload: payload || {}, at: Date.now() });
    const obj = await sdk.upload(new PinnedObject(), new Blob([body]).stream());
    await sdk.pinObject(obj);
    return typeof obj.id === "function" ? obj.id() : obj.id;
  }

  const BOX_DOMAIN = new TextEncoder().encode("yada-sia-box-v1");
  const BOX_PRIV = "yada-sia-box-priv";

  function unb64(text) {
    const raw = atob(String(text || "").replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function sha256Bytes(bytes) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  }

  async function boxPubHex() {
    if (!crypto.subtle || !crypto.subtle.generateKey) {
      throw new Error("this browser cannot do the storage DH");
    }
    const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    localStorage.setItem(BOX_PRIV, JSON.stringify(jwk));
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function openBox(blobB64) {
    const saved = localStorage.getItem(BOX_PRIV);
    localStorage.removeItem(BOX_PRIV);
    if (!saved) throw new Error("storage DH key is missing");
    const jwk = JSON.parse(saved);
    const priv = await crypto.subtle.importKey("jwk", jwk, { name: "X25519" }, false, ["deriveBits"]);
    const blob = unb64(blobB64);
    if (blob.length < 45) throw new Error("sealed storage key is truncated");
    const ephPub = blob.slice(0, 32);
    const nonce = blob.slice(32, 44);
    const ct = blob.slice(44);
    const pub = await crypto.subtle.importKey("raw", ephPub, { name: "X25519" }, false, []);
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256)
    );
    const material = new Uint8Array(shared.length + BOX_DOMAIN.length);
    material.set(shared, 0);
    material.set(BOX_DOMAIN, shared.length);
    const aes = await crypto.subtle.importKey("raw", await sha256Bytes(material), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ct);
    return new TextDecoder().decode(plain);
  }

  function storeKey(hex) {
    const clean = String(hex || "").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("invalid App Key");
    localStorage.setItem(KEY, clean.toLowerCase());
  }

  async function uploadBlob(blob, filename, mime) {
    const sdk = await reconnect();
    if (!sdk) throw new Error("storage account is not set up");
    const { PinnedObject } = await sdkLib();
    const upload = sdk.upload(new PinnedObject(), blob.stream(), {
      onShardUploaded: function () {},
    });
    const timeout = new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error("no Sia host answered. Those QUIC timeouts are hosts this browser could not reach"));
      }, 90000);
    });
    const obj = await Promise.race([upload, timeout]);
    if (obj.updateMetadata) {
      obj.updateMetadata(
        new TextEncoder().encode(
          JSON.stringify({ filename: filename || "", mime_type: mime || "" })
        )
      );
    }
    await sdk.pinObject(obj);
    const expires = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
    const key = await sdk.createSharingKey("yadacoin-file-announcement", expires);
    await sdk.shareObject(key, obj);
    const seed = String(key.seed() || "").replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) throw new Error("sharing key seed is not 64 hex");
    return {
      file_id: typeof obj.id === "function" ? obj.id() : obj.id,
      share_url: "sia-share:v1:" + seed.toLowerCase(),
      size: blob.size,
    };
  }

  window.YadaSia = {
    hasKey: function () { return !!storedKey(); },
    boxPubHex: boxPubHex,
    openBox: openBox,
    storeKey: storeKey,
    reconnect: reconnect,
    connect: connect,
    ensure: ensure,
    putActivity: putActivity,
    uploadBlob: uploadBlob,
  };
})();
