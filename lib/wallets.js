const crypto = require("crypto");

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const EVM_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const BECH32_RE = /\bbc1[a-zA-Z0-9]{8,87}\b/g;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{25,44}\b/g;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const i = BASE58.indexOf(ch);
    if (i < 0) return null;
    num = num * 58n + BigInt(i);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  for (const ch of str) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

// Returns the version byte if the checksum is valid (Bitcoin legacy / Tron), otherwise null
function base58CheckVersion(bytes) {
  if (!bytes || bytes.length !== 25) return null;
  const payload = bytes.subarray(0, 21);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return checksum.equals(bytes.subarray(21)) ? payload[0] : null;
}

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function isValidBitcoinBech32(address) {
  const lower = address.toLowerCase();
  if (address !== lower && address !== address.toUpperCase()) return false;
  const sep = lower.lastIndexOf("1");
  const hrp = lower.slice(0, sep);
  if (hrp !== "bc") return false;
  const data = [...lower.slice(sep + 1)].map((c) => BECH32.indexOf(c));
  if (data.length < 6 || data.some((d) => d < 0)) return false;
  const hrpExpanded = [
    ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map((c) => c.charCodeAt(0) & 31),
  ];
  const result = bech32Polymod([...hrpExpanded, ...data]);
  return result === 1 || result === 0x2bc830a3; // bech32 or bech32m (taproot)
}

// Finds wallet addresses in a piece of text. Each result: { address, chain, key }
// `key` is a normalised form used to spot duplicates.
function extractWallets(text) {
  const found = new Map();
  const add = (address, chain, key) => {
    if (!found.has(key)) found.set(key, { address, chain, key });
  };

  for (const m of text.matchAll(EVM_RE)) {
    add(m[0], "EVM", m[0].toLowerCase());
  }

  for (const m of text.matchAll(BECH32_RE)) {
    if (isValidBitcoinBech32(m[0])) add(m[0], "Bitcoin", m[0].toLowerCase());
  }

  for (const m of text.matchAll(BASE58_RE)) {
    const candidate = m[0];
    const bytes = base58Decode(candidate);
    if (!bytes) continue;

    if (bytes.length === 32 && candidate.length >= 32) {
      add(candidate, "Solana", candidate);
      continue;
    }

    const version = base58CheckVersion(bytes);
    if (version === 0x00 || version === 0x05) add(candidate, "Bitcoin", candidate);
    else if (version === 0x41) add(candidate, "Tron", candidate);
  }

  return [...found.values()];
}

module.exports = { extractWallets };