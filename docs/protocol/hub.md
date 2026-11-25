# The hub

A hub is a node with three more duties: it knows users, their devices and the nodes linked to it;
it routes a client's frames to the node they name; it keeps each hub user's UI settings.

## Devices

A device connects to `wss://<hub>/client` with a device token in its `hello`. A device gets its
token by pairing: `harness hub device add <user> --name <device>` makes a one-time code (ten
minutes, stored as a SHA-256 hash); the device sends it to `POST https://<hub>/pair { code }` and
receives `{ user, device, token }` (the token stored as a hash; the code is spent). The
connection is that user's: `nodes_list` shows the hub's node only to admins and users the hub's
own node lists, and every node the user may use with its presence.

## Routing

A frame whose `node` names another node goes to that node's link; the hub does not read it. If the
user may not use the node the hub answers `forbidden`, if the node is not linked `node_offline`.
The node checks the user again on its side (its configuration's `users`).

## Node links

A node links to a hub by connecting to `wss://<hub>/uplink` with its key in `hello` (made by
`harness hub node add <name> --users a,b`, shown once). It connects out, so a node behind NAT
needs no open port, and reconnects with backoff when the link drops. Over the link the hub opens
one channel per client (`route` frames carry the client's frames and its user; `route_close` ends
it); the node treats each channel as a client connection of that user. When a node links or drops,
the hub sends a `nodes` event to every client.
