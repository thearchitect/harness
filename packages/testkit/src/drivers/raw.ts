// The raw driver: the bare hub protocol, for scenarios that test the protocol itself. It keeps a
// ClientModel too, so its state is reported like any client's.

import type { HubConnection } from "#client/connection.ts";
import { ClientModel } from "#client/model/client-model.ts";

export class RawDriver {
  readonly client: ClientModel;
  readonly hub: string;

  private constructor(client: ClientModel, node: string) {
    this.client = client;
    this.hub = node;
  }

  static async open(open: () => Promise<HubConnection>): Promise<RawDriver> {
    const client = new ClientModel();
    const node = await client.addEndpoint(open, { home: true });
    return new RawDriver(client, node);
  }

  get api() {
    return this.client.connection(this.hub);
  }

  stop(): void {
    this.client.dispose();
  }
}
