import { createPlatform } from './app.js';
import { getConfig } from './config.js';

const config = getConfig();
const { app } = await createPlatform();

app.listen({ port: config.port, host: '127.0.0.1' }, () => {
  console.log(`Backend listening on http://localhost:${config.port}`);
});
