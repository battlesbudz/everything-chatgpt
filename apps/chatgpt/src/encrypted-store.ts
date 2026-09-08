import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

type Envelope = { version: 1; iv: string; tag: string; ciphertext: string };

function keyFromEnvironment(): Buffer {
  const configured = process.env.ECG_SESSION_ENCRYPTION_KEY?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") throw new Error("ECG_SESSION_ENCRYPTION_KEY is required in production.");
    return crypto.createHash("sha256").update("everything-chatgpt-development-only").digest();
  }
  const decoded = /^[0-9a-f]{64}$/i.test(configured) ? Buffer.from(configured, "hex") : Buffer.from(configured, "base64");
  if (decoded.length !== 32) throw new Error("ECG_SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return decoded;
}

/** Small encrypted, atomic JSON store for OAuth/session state. Use a durable mounted path in production. */
export class EncryptedJsonStore<T extends object> {
  private readonly filePath: string;
  private readonly key = keyFromEnvironment();
  private values: Record<string, T> = {};

  constructor(name: string) {
    const root = process.env.ECG_SESSION_STORE_PATH?.trim() || path.join(process.cwd(), ".ecg-data");
    this.filePath = path.join(root, `${name}.enc.json`);
    this.load();
  }

  get(key: string): T | undefined { return this.values[key]; }
  set(key: string, value: T): void { this.values[key] = value; this.flush(); }
  delete(key: string): void { delete this.values[key]; this.flush(); }
  clear(): void { this.values = {}; this.flush(); }

  private load(): void {
    try {
      const envelope = JSON.parse(readFileSync(this.filePath, "utf8")) as Envelope;
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
      this.values = JSON.parse(plaintext) as Record<string, T>;
    } catch {
      this.values = {};
    }
  }

  private flush(): void {
    const root = path.dirname(this.filePath);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.values), "utf8"), cipher.final()]);
    const envelope: Envelope = { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}
