// One-off local dev helper: generates an RSA-2048 keypair for JWT RS256,
// equivalent to `openssl genrsa` + `openssl rsa -pubout`, using only Node's
// built-in crypto module (no external OpenSSL install required).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const keysDir = path.join(__dirname, "..", "apps", "api", "keys");
fs.mkdirSync(keysDir, { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

fs.writeFileSync(path.join(keysDir, "private.pem"), privateKey);
fs.writeFileSync(path.join(keysDir, "public.pem"), publicKey);

console.log("Generated apps/api/keys/private.pem and public.pem");
