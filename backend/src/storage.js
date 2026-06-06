import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, GetObjectCommand, HeadBucketCommand, PutObjectCommand, CreateBucketCommand } from '@aws-sdk/client-s3';

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

  async writeToResponse(key, res) {
    res.sendFile(this.filePath(key));
  }
}

export class MinioStorage {
  constructor(config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async ensureReady() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      if (status !== 404 && error?.name !== 'NotFound') throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async saveBuffer(key, buffer, contentType = 'application/octet-stream') {
    await this.ensureReady();
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
    return key;
  }

  async readBuffer(key) {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async exists(key) {
    try {
      await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: 'bytes=0-0',
      }));
      return true;
    } catch {
      return false;
    }
  }

  async writeToResponse(key, res) {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    if (response.ContentType) res.setHeader('Content-Type', response.ContentType);
    if (response.ContentLength) res.setHeader('Content-Length', String(response.ContentLength));
    response.Body.pipe(res);
  }
}
