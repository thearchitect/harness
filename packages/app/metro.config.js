// Metro for every target: the app's own sources, plus the isomorphic `protocol` and `client`
// packages of the repository, imported as the rest of harness does (`#protocol/…`, `#client/…`).

const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const root = path.resolve(__dirname, "../..");
const shared = {
  "#protocol/": path.join(root, "packages/protocol/src/"),
  "#client/": path.join(root, "packages/client/src/"),
  // the gallery route draws the shared fixtures
  "#testkit/fixtures/": path.join(root, "packages/testkit/src/fixtures/"),
};

const config = getDefaultConfig(__dirname);
config.watchFolders = [...Object.values(shared)];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  for (const [prefix, dir] of Object.entries(shared)) {
    if (moduleName.startsWith(prefix)) {
      return { type: "sourceFile", filePath: path.join(dir, moduleName.slice(prefix.length)) };
    }
  }
  // the shared packages' own npm imports (the client's @xterm/headless) resolve from the app's modules
  // as node resolves them (@xterm/headless names a `module` it does not ship)
  const fromShared = Object.values(shared).some((dir) => context.originModulePath.startsWith(dir));
  if (fromShared && !moduleName.startsWith(".")) {
    return { type: "sourceFile", filePath: require.resolve(moduleName, { paths: [__dirname] }) };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
