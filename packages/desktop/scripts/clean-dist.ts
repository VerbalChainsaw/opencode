#!/usr/bin/env bun

import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptsDir, "..")
const distDir = path.resolve(packageDir, "dist")
const rel = path.relative(packageDir, distDir)

if (rel !== "dist") {
  throw new Error(`Refusing to clean unexpected output directory: ${distDir}`)
}

await rm(distDir, { recursive: true, force: true })
console.log(`cleaned ${distDir}`)
