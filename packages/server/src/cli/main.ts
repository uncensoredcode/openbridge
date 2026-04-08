#!/usr/bin/env node
import { cliModule } from "./index.ts";

const { runBridgeServerCli } = cliModule;
const exitCode = await runBridgeServerCli({
  argv: process.argv.slice(2)
});
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
