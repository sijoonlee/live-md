import {spawn, type ChildProcess} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

// Starting the live-md server on demand, so "live-md: Open" works from a cold start
// instead of failing with a blank frame until you remember to run `npm run dev` in
// another terminal.
//
// Only ever started when the configured URL is unreachable, so a server you are
// already running — in a terminal, or from another window — is left alone and never
// duplicated on its port.

let child: ChildProcess | undefined;
let output: vscode.OutputChannel | undefined;

const channel = () => (output ??= vscode.window.createOutputChannel("live-md server"));

export const isRunning = () => child !== undefined && child.exitCode === null;

export async function isReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    await fetch(`${url}/api/me`, {signal: AbortSignal.timeout(timeoutMs)});
    return true;
  } catch {
    return false;
  }
}

// The repository to run from: the configured path, else whichever open workspace
// folder actually is live-md. Matching on the package name rather than assuming the
// first folder keeps this correct in a multi-root workspace.
export function resolveServerDir(): string | undefined {
  const configured = vscode.workspace.getConfiguration("liveMd").get<string>("serverPath")?.trim();
  if (configured) return configured;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const manifest = path.join(folder.uri.fsPath, "package.json");
    try {
      if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === "live-md") return folder.uri.fsPath;
    } catch {
      // Not a Node project, or unreadable — keep looking.
    }
  }
  return undefined;
}

// Start the server and wait for it to answer. Resolves false (having explained why)
// rather than throwing, so the caller can still open the panel: the server may yet
// come up, and a blank frame with a message beats no window at all.
export async function start(url: string, port: number | undefined): Promise<boolean> {
  if (isRunning()) return true;

  const cwd = resolveServerDir();
  if (!cwd) {
    void vscode.window
      .showErrorMessage(
        "Could not find the live-md repository to start. Set liveMd.serverPath to its location.",
        "Open Settings",
      )
      .then((action) => {
        if (action) void vscode.commands.executeCommand("workbench.action.openSettings", "liveMd.serverPath");
      });
    return false;
  }

  const script = vscode.workspace.getConfiguration("liveMd").get<string>("startCommand") || "npm run dev";
  channel().appendLine(`$ ${script}   (cwd: ${cwd})`);

  child = spawn(script, {
    cwd,
    // shell: npm is a shell script on POSIX and a .cmd on Windows, and the extension
    // host's PATH is not the login shell's.
    shell: true,
    // Its own process group, so stopping it takes the whole tree down: `npm run dev`
    // spawns tsx, which spawns node, and killing only npm would orphan the listener
    // still holding the port.
    detached: process.platform !== "win32",
    env: {...process.env, ...(port === undefined ? {} : {PORT: String(port)})},
  });
  child.stdout?.on("data", (data: Buffer) => channel().append(data.toString()));
  child.stderr?.on("data", (data: Buffer) => channel().append(data.toString()));
  child.on("exit", (code) => {
    channel().appendLine(`\n[server exited with code ${code}]`);
    child = undefined;
  });

  return vscode.window.withProgress(
    {location: vscode.ProgressLocation.Notification, title: "Starting the live-md server…"},
    async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (!isRunning()) {
          void vscode.window
            .showErrorMessage("The live-md server exited while starting.", "Show Output")
            .then((action) => action && channel().show());
          return false;
        }
        if (await isReachable(url)) return true;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      void vscode.window
        .showWarningMessage("The live-md server did not become reachable within 30s.", "Show Output")
        .then((action) => action && channel().show());
      return false;
    },
  );
}

// Only ever stops a server this extension started; one you run yourself is not ours
// to kill.
export function stop(): void {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else process.kill(-child.pid, "SIGTERM"); // negative pid: the whole process group
  } catch {
    child.kill("SIGTERM");
  }
  child = undefined;
}
