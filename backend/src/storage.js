import fs from 'node:fs/promises';
import path from 'node:path';

export class LocalStorage {
  constructor(storageDir) {
    this.storageDir = storageDir;
  }

  async ensureReady() {
    await fs.mkdir(this.storageDir, { recursive: true });
  }

  async saveBuffer(key, buffer) {
    await this.ensureReady();
    const target = path.join(this.storageDir, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    return target;
  }

  async readBuffer(key) {
    return fs.readFile(path.join(this.storageDir, key));
  }

  async exists(key) {
    try {
      await fs.access(path.join(this.storageDir, key));
      return true;
    } catch {
      return false;
    }
  }

  filePath(key) {
    return path.join(this.storageDir, key);
  }
}
