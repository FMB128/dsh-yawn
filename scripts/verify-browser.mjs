/**
 * Verify a bootstrapped sandbox: install the browser, then prove it renders.
 *
 * Usage: node verify-browser.mjs [install-browser]
 *
 * The installer defaults to `install-browser`, the command the runner image
 * ships; pass a path to check a copy outside an image.
 *
 * The check drives Chrome over the DevTools Protocol directly rather than
 * through `agent-browser`. That keeps the assertion about the *browser* — does
 * it start, navigate, give a DOM, and have a font to draw with — separate from
 * any CLI behaviour, so a failure here points at the environment rather than
 * at a wrapper.
 *
 * The font is part of the assertion because a browser without one still
 * navigates and still answers DOM queries; it just draws nothing. Every
 * capture comes out blank, so a DOM check alone passes on a browser that is
 * useless for the screenshots this exists to take.
 *
 * Node's global WebSocket and fetch are enough for this; no dependencies.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const installer = process.argv[2] ?? "install-browser";

const home = homedir();
const envFile = join(home, ".local", "share", "agent-browser-env.sh");

/** Parse the generated env file: the wrapper is what actually carries the libs. */
function readEnvFile() {
  const values = {};
  const text = execFileSync("cat", [envFile], { encoding: "utf8" });
  for (const line of text.split("\n")) {
    const match = /^export ([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match !== null) {
      values[match[1]] = match[2].replace(/\$\{[^}]*:-?\}/g, "");
    }
  }
  return values;
}

/** Ask Chrome for its CDP endpoint, then drive one page. */
async function checkRendering(chromeWrapper, libraryPath) {
  const userDataDir = join("/tmp", `cdp-verify-${process.pid}`);
  rmSync(userDataDir, { recursive: true, force: true });
  mkdirSync(userDataDir, { recursive: true });

  const { spawn } = await import("node:child_process");
  const chrome = spawn(
    chromeWrapper,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { env: { ...process.env, LD_LIBRARY_PATH: libraryPath }, stdio: "ignore" },
  );

  try {
    // Chrome writes the port it chose beside the profile when asked for port 0.
    const portFile = join(userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + 30_000;
    while (!existsSync(portFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!existsSync(portFile)) {
      throw new Error("Chrome never wrote DevToolsActivePort");
    }
    const { readFileSync } = await import("node:fs");
    const port = readFileSync(portFile, "utf8").split("\n")[0].trim();

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((entry) => entry.type === "page");
    if (page === undefined) throw new Error("no page target");

    const socket = new WebSocket(page.webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const resolve = pending.get(message.id);
      if (resolve !== undefined) {
        pending.delete(message.id);
        resolve(message);
      }
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const send = (method, params = {}) => {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    };

    await send("Page.enable");
    await send("Page.navigate", {
      url: "data:text/html,<h1 id=t>bootstrap-renders</h1>",
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const evaluated = await send("Runtime.evaluate", {
      expression: "document.querySelector('h1')?.textContent ?? ''",
      returnByValue: true,
    });
    const measured = await send("Runtime.evaluate", {
      expression:
        "(() => { const context = document.createElement('canvas').getContext('2d'); context.font = '16px sans-serif'; return context.measureText('bootstrap renders').width; })()",
      returnByValue: true,
    });
    socket.close();

    const text = evaluated.result?.result?.value ?? "";
    if (text !== "bootstrap-renders") {
      throw new Error(`page did not render (h1=${JSON.stringify(text)})`);
    }
    const textWidth = measured.result?.result?.value ?? 0;
    if (!(textWidth > 0)) {
      throw new Error("no font is installed, so the browser draws no text");
    }
    return `${version.Browser} (text width ${textWidth})`;
  } finally {
    chrome.kill("SIGKILL");
  }
}

console.log(`--- installing the browser (${installer})`);
execFileSync(installer, [], { stdio: "inherit" });
chmodSync(envFile, 0o644);

const env = readEnvFile();
const wrapper = join(home, ".local", "bin", "google-chrome");
if (!existsSync(wrapper)) throw new Error(`no wrapper at ${wrapper}`);

const browser = await checkRendering(wrapper, env.LD_LIBRARY_PATH ?? "");
console.log(`--- browser rendered a page: ${browser}`);

// `agent-browser --ca-cert` creates an NSS database with certutil, found on
// the PATH the env file sets.
const nssDir = join("/tmp", `nss-verify-${process.pid}`);
rmSync(nssDir, { recursive: true, force: true });
mkdirSync(nssDir, { recursive: true });
execFileSync(
  "sh",
  [
    "-c",
    '. "$1" && certutil -N --empty-password -d "sql:$2"',
    "sh",
    envFile,
    nssDir,
  ],
  { stdio: "inherit" },
);
rmSync(nssDir, { recursive: true, force: true });
console.log("--- certutil runs from the env file");
console.log("--- bootstrap verified");
