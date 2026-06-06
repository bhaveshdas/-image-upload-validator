export class EventHub {
  constructor() {
    this.clients = new Set();
  }

  add(res) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  emit(event, payload) {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      client.write(data);
    }
  }
}
