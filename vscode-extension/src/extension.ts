import * as vscode from "vscode";

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
  );
}

export function deactivate() {
  panel?.dispose();
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
// explanation, so check first and say what is wrong. Failure is not fatal — the
// panel still opens, since the server may simply be starting up.
async function warnIfUnreachable(url: string): Promise<void> {
  try {
    await fetch(`${url}/api/me`, {signal: AbortSignal.timeout(2000)});
  } catch {
    const action = await vscode.window.showWarningMessage(
      `Could not reach a live-md server at ${url}. Is it running?`,
      "Open Settings",
    );
    if (action === "Open Settings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "liveMd.url");
    }
  }
}

function open() {
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
  panel.webview.html = frame(url);
  panel.onDidDispose(() => (panel = undefined));

  void warnIfUnreachable(url);
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
