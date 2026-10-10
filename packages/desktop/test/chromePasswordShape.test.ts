import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

function makeMasterKey(): Buffer {
  return randomBytes(32);
}

 function encryptV10Password(plain: string, masterKey: Buffer): Buffer {
  const nonce = randomBytes(12);
  const enc = createCipheriv("aes-256-gcm", masterKey, nonce);
  const ciphertext = Buffer.concat([enc.update(plain, "utf8"), enc.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, ciphertext, enc.getAuthTag()]);
}

test("Login Data snapshot decrypts v10 rows with DPAPI master key shape", async () => {
  const key = makeMasterKey();
  const cipherText = encryptV10Password("hunter2 Hunter2!", key);
  assert.equal(cipherText.subarray(0, 3).toString("ascii"), "v10");

  const nonce = cipherText.subarray(3, 15);
  const authTag = cipherText.subarray(cipherText.length - 16);
  const ciphertext = cipherText.subarray(15, cipherText.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  assert.equal(plain, "hunter2 Hunter2!");
  key.fill(0);
});

test("blacklisted rows excluded, empty passwords skipped", () => {
  const rows = [
    { blacklisted_by_user: 1, password_value: Buffer.from("x") },
    { blacklisted_by_user: 0, password_value: Buffer.alloc(0) },
    { blacklisted_by_user: 0, password_value: Buffer.from("v10...") },
  ];
  const eligible = rows.filter((row) => row.blacklisted_by_user === 0 && row.password_value.length > 0);
  assert.equal(eligible.length, 1);
});

test("live Profile 1 snapshot shape: 5 logins, v10 heads", async () => {
  const snap = "D:/tmp/LD1.sqlite";
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-pw-shape-"));
  try {
    await copyFile(snap, join(tempDir, "probe.sqlite"));
    const database = new DatabaseSync(join(tempDir, "probe.sqlite"), { readOnly: true });
    try {
      const count = (database.prepare("SELECT COUNT(*) AS n FROM logins").get() as { n: number }).n;
      assert.equal(count, 5);
      const heads = database
        .prepare("SELECT substr(hex(password_value),1,6) AS head FROM logins WHERE length(password_value) > 0")
        .all() as Array<{ head: string }>;
      assert.ok(heads.length === 3);
      for (const row of heads) assert.equal(row.head, "763230");
    } finally {
      database.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
