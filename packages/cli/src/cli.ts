#!/usr/bin/env node
import { bridgeCli } from "./index.ts";

const { runBridgeCli } = bridgeCli;
const exitCode = await runBridgeCli({
  argv: process.argv.slice(2)
});
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
