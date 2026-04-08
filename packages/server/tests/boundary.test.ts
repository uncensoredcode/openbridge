import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import * as bridgeServer from "../src/index.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
test("public bridge server exports do not leak Telegram or product-specific names", () => {
  const exportNames = Object.keys(bridgeServer);
  assert.equal(
    exportNames.some((name) => /telegram|discord|openclaw|bridge-core/i.test(name)),
    false
  );
});
test("public API schema is transport-agnostic and product-agnostic", async () => {
  const source = await readFile(path.join(packageRoot, "src", "shared", "api-schema.ts"), "utf8");
  assert.doesNotMatch(source, /telegram|discord|openclaw|bridge-core/i);
});
test("standalone API depends on bridge runtime, not Telegram adapter logic", async () => {
  const serviceSource = await readFile(
    path.join(packageRoot, "src", "bridge", "bridge-runtime-service.ts"),
    "utf8"
  );
  const serverSource = await readFile(
    path.join(packageRoot, "src", "http", "create-bridge-api-server.ts"),
    "utf8"
  );
  const commandSource = await readFile(
    path.join(packageRoot, "src", "cli", "run-bridge-server-cli.ts"),
    "utf8"
  );
  assert.match(serviceSource, /from "@openbridge\/runtime"/);
  assert.doesNotMatch(serviceSource, /telegram-runtime-adapter/);
  assert.doesNotMatch(serverSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.match(commandSource, /from "\.\.\/http\/index\.ts"/);
  assert.doesNotMatch(commandSource, /telegram|openclaw|bridge-core/i);
});
test("provider admin API stays inside the standalone bridge-server boundary", async () => {
  const routeSource = await readFile(
    path.join(packageRoot, "src", "http", "routes", "admin-routes.ts"),
    "utf8"
  );
  const providerSessionResolverSource = await readFile(
    path.join(packageRoot, "src", "bridge", "providers", "provider-session-resolver.ts"),
    "utf8"
  );
  const serverSource = await readFile(
    path.join(packageRoot, "src", "http", "create-bridge-api-server.ts"),
    "utf8"
  );
  const providerStoreSource = await readFile(
    path.join(packageRoot, "src", "bridge", "stores", "provider-store.ts"),
    "utf8"
  );
  const sessionPackageStoreSource = await readFile(
    path.join(packageRoot, "src", "bridge", "stores", "session-package-store.ts"),
    "utf8"
  );
  const sessionStoreSource = await readFile(
    path.join(packageRoot, "src", "bridge", "stores", "session-store.ts"),
    "utf8"
  );
  assert.match(routeSource, /\/v1\/providers/);
  assert.match(routeSource, /\/v1\/providers\/:id\/session-package/);
  assert.match(routeSource, /\/v1\/sessions/);
  assert.match(serverSource, /createSessionBackedProviderStore/);
  assert.match(serverSource, /createLocalSessionPackageStore/);
  assert.match(serverSource, /createInMemorySessionStore/);
  assert.doesNotMatch(routeSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.doesNotMatch(providerSessionResolverSource, /telegram|openclaw|bridge-core/i);
  assert.doesNotMatch(providerStoreSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.doesNotMatch(sessionPackageStoreSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.doesNotMatch(sessionStoreSource, /telegram|openclaw|legacy|bridge-core/i);
});
test("model discovery API stays inside the standalone bridge-server boundary", async () => {
  const routeSource = await readFile(
    path.join(packageRoot, "src", "http", "routes", "admin-routes.ts"),
    "utf8"
  );
  const modelCatalogSource = await readFile(
    path.join(packageRoot, "src", "bridge", "bridge-model-catalog.ts"),
    "utf8"
  );
  assert.match(routeSource, /\/v1\/models/);
  assert.match(routeSource, /buildModelListResponse/);
  assert.doesNotMatch(routeSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.doesNotMatch(modelCatalogSource, /telegram|openclaw|legacy|bridge-core/i);
});
test("chat completions API stays inside the standalone bridge-server boundary", async () => {
  const routeSource = await readFile(
    path.join(packageRoot, "src", "http", "routes", "chat-completions-route.ts"),
    "utf8"
  );
  const chatCompletionServiceSource = await readFile(
    path.join(packageRoot, "src", "bridge", "chat-completions", "chat-completion-service.ts"),
    "utf8"
  );
  const serviceSource = await readFile(
    path.join(packageRoot, "src", "bridge", "bridge-runtime-service.ts"),
    "utf8"
  );
  const modelCatalogSource = await readFile(
    path.join(packageRoot, "src", "bridge", "bridge-model-catalog.ts"),
    "utf8"
  );
  const providerStreamsSource = await readFile(
    path.join(packageRoot, "src", "bridge", "providers", "provider-streams.ts"),
    "utf8"
  );
  const clientSource = await readFile(
    path.join(packageRoot, "src", "client", "bridge-api-client.ts"),
    "utf8"
  );
  const commandSource = await readFile(
    path.join(packageRoot, "src", "cli", "run-bridge-server-cli.ts"),
    "utf8"
  );
  const transportSource = await readFile(
    path.join(packageRoot, "src", "bridge", "providers", "web-provider-transport.ts"),
    "utf8"
  );
  assert.match(routeSource, /\/v1\/chat\/completions/);
  assert.match(routeSource, /chat-completion-service/);
  assert.match(chatCompletionServiceSource, /resolveBridgeModel/);
  assert.match(serviceSource, /from "@openbridge\/runtime"/);
  assert.match(commandSource, /from "\.\.\/client\/index\.ts"/);
  assert.doesNotMatch(routeSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.doesNotMatch(chatCompletionServiceSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.doesNotMatch(serviceSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.doesNotMatch(modelCatalogSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.doesNotMatch(clientSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.doesNotMatch(commandSource, /telegram|openclaw|legacy|bridge-core/i);
  assert.doesNotMatch(providerStreamsSource, /telegram|openclaw|bridge-core/i);
  assert.doesNotMatch(transportSource, /telegram|openclaw|bridge-core/i);
});
