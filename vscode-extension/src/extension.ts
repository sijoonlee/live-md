import * as vscode from "vscode";
import {isReachable, isRunning, resolveServerDir, start, stop} from "./server-process.js";

// live-md inside VS Code. The webview hosts the existing browser client unchanged —
// there is no bridge to a TextDocument and no second replica of the text, because
// live-md documents are not files: they live on the server, and the client already
// knows how to edit them.
//
// The reason this extension exists at all, rather than "just use Simple Browser", is
// `retainContextWhenHidden`. Simple Browser's webview is torn down when its tab is
// hidden and rebuilt when shown, which reloads the page — so switching to the
// terminal and back lost the caret, the selection, and the scroll position mid-edit.
// This panel keeps its context alive instead.

const DEFAULT_URL = "http://localhost:3000";

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("liveMd.open", () => open()),
    vscode.commands.registerCommand("liveMd.reload", () => reload()),
    vscode.commands.registerCommand("liveMd.startServer", () => start(configuredUrl(), portOf(configuredUrl()))),
    vscode.commands.registerCommand("liveMd.stopServer", () => stop()),
    // A server this extension started is its responsibility to clean up; leaving it
    // running after the window closes would hold the port with nothing to stop it.
    {dispose: stop},
  );
}

export function deactivate() {
  panel?.dispose();
  stop();
}

const configuredUrl = () =>
  (vscode.workspace.getConfiguration("liveMd").get<string>("url") ?? DEFAULT_URL).replace(/\/+$/, "");

// The port the server listens on, so the webview keeps working over Remote-SSH and
// in Codespaces, where "localhost" inside the webview is not the machine running the
// server.
const portOf = (url: string): number | undefined => {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
};

// A webview that cannot reach the server renders as a blank frame with no
// explanation. So make sure there is something to talk to first: reuse a server
// that is already answering, otherwise start one.
async function ensureServer(url: string): Promise<void> {
  if (await isReachable(url)) return;

  if (!vscode.workspace.getConfiguration("liveMd").get<boolean>("autoStart", true)) {
    const action = await vscode.window.showWarningMessage(
      `Could not reach a live-md server at ${url}.`,
      "Start Server",
      "Open Settings",
    );
    if (action === "Start Server") await start(url, portOf(url));
    if (action === "Open Settings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "liveMd.url");
    }
    return;
  }

  // Nothing to start against, and nothing running: say so rather than silently
  // opening an empty panel.
  if (!resolveServerDir() && !isRunning()) {
    void vscode.window.showWarningMessage(
      `Could not reach a live-md server at ${url}, and no live-md repository is open to start one. ` +
        `Set liveMd.serverPath, or start it yourself.`,
    );
    return;
  }
  await start(url, portOf(url));
}

function open(): void {
  if (panel) {
    panel.reveal(panel.viewColumn);
    return;
  }
  const url = configuredUrl();
  const port = portOf(url);

  panel = vscode.window.createWebviewPanel("liveMd", "live-md", vscode.ViewColumn.Active, {
    enableScripts: true,
    // The entire point of this extension: keep the page alive while its tab is in
    // the background, so a mid-edit caret survives a trip to the terminal.
    retainContextWhenHidden: true,
    portMapping: port === undefined ? undefined : [{webviewPort: port, extensionHostPort: port}],
  });
  panel.onDidDispose(() => (panel = undefined));

  // Load the frame only once there is a server answering; pointing an iframe at a
  // dead port caches a browser error page that a later reload has to clear.
  void ensureServer(url).then(() => {
    if (panel) panel.webview.html = frame(url, Date.now());
  });
}

function reload() {
  if (!panel) return open();
  // Re-assigning html reloads the frame; a cache-busting param defeats any cached
  // bundle, which is the usual reason a reload appears to do nothing.
  panel.webview.html = frame(configuredUrl(), Date.now());
}

// The webview is a shell around one iframe. Everything the user interacts with is
// the live-md client itself, served by the server.
function frame(url: string, cacheBust?: number): string {
  const src = cacheBust ? `${url}/?reload=${cacheBust}` : `${url}/`;
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; frame-src ${url} http://localhost:* http://127.0.0.1:*; style-src 'unsafe-inline';">
    <style>
      html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
      iframe { display: block; width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body><iframe src="${src}" allow="clipboard-read; clipboard-write"></iframe></body>
</html>`;
}
