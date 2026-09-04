import assert from "node:assert/strict";
import {test} from "node:test";
import * as Y from "yjs";
import {AgentClient} from "../../src/agent-client.js";

const encode = (value: Uint8Array) => Buffer.from(value).toString("base64");
const decode = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

const makeFetch = (serverDoc: Y.Doc, options: {failUpdates?: number} = {}) => {
  const calls: {path: string; body?: any}[] = [];
  let failuresRemaining = options.failUpdates ?? 0;
  const requestIds = new Set<string>();
  const serverText = serverDoc.getText("content");

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({path, body});

    // The client always targets the id-keyed API (/api/documents/:id/*).
    if (path.endsWith("/state")) {
      return new Response(JSON.stringify({update: encode(Y.encodeStateAsUpdate(serverDoc))}), {status: 200});
    }
    if (path.endsWith("/sync")) {
      return new Response(JSON.stringify({
        update: encode(Y.encodeStateAsUpdate(serverDoc, decode(body.stateVector))),
      }), {status: 200});
    }
    if (path.endsWith("/updates")) {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("temporary network failure");
      }
      if (!requestIds.has(body.requestId)) {
        requestIds.add(body.requestId);
        Y.applyUpdate(serverDoc, decode(body.update));
      }
      return new Response(JSON.stringify({revision: requestIds.size}), {status: 202});
    }
    if (path.endsWith("/cursor")) {
      return new Response(JSON.stringify(body), {status: 200});
    }
    return new Response(JSON.stringify({error: "not found"}), {status: 404});
  };

  return {fetch, calls, serverText};
};

test("AgentClient loads, edits, syncs, and publishes cursors", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.getText("content").insert(0, "Hello");
  const mock = makeFetch(serverDoc);
  const client = new AgentClient({agentId: "agent-test", documentId: 1, fetch: mock.fetch});

  await client.load();
  assert.equal(client.text.toString(), "Hello");
  await client.insert(5, " world", {reason: "test edit"});
  assert.equal(mock.serverText.toString(), "Hello world");

  serverDoc.getText("content").insert(0, "Updated: ");
  await client.sync();
  assert.equal(client.text.toString(), "Updated: Hello world");

  await client.setCursor(3, 7, "Test agent");
  assert.equal(mock.calls.at(-1)?.path, "/api/documents/1/cursor");
});

test("AgentClient retries and propagates a final failure", async () => {
  const serverDoc = new Y.Doc();
  const retryMock = makeFetch(serverDoc, {failUpdates: 1});
  const client = new AgentClient({agentId: "retry-agent", documentId: 1, fetch: retryMock.fetch, retries: 2});
  await client.load();
  await client.insert(0, "retried");
  assert.equal(serverDoc.getText("content").toString(), "retried");
  assert.equal(retryMock.calls.filter((call) => call.path === "/api/documents/1/updates").length, 2);

  const failingMock = makeFetch(new Y.Doc(), {failUpdates: 5});
  const failingClient = new AgentClient({agentId: "failing-agent", documentId: 1, fetch: failingMock.fetch, retries: 1});
  await failingClient.load();
  await assert.rejects(() => failingClient.insert(0, "fail"), /temporary network failure/);
});

test("AgentClient names itself on every request, for attribution", async () => {
  const seen: (string | null)[] = [];
  const serverDoc = new Y.Doc();
  const base = makeFetch(serverDoc);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string> | undefined)?.["x-agent-id"] ?? null);
    return base.fetch(input, init);
  };
  const client = new AgentClient({agentId: "tok-agent", documentId: 1, fetch});
  await client.load();
  await client.insert(0, "hi");
  assert.ok(seen.length > 0);
  assert.ok(seen.every((value) => value === "tok-agent"));
});

test("AgentClient with a documentId targets the id-keyed document API", async () => {
  const paths: string[] = [];
  const serverDoc = new Y.Doc();
  serverDoc.getText("content").insert(0, "Hi");
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === "/api/documents/42/state") return new Response(JSON.stringify({update: encode(Y.encodeStateAsUpdate(serverDoc))}), {status: 200});
    if (path === "/api/documents/42/updates") return new Response(JSON.stringify({revision: 1}), {status: 202});
    if (path === "/api/documents/42/cursor") return new Response(JSON.stringify({}), {status: 200});
    return new Response(JSON.stringify({error: "not found"}), {status: 404});
  };
  const client = new AgentClient({agentId: "doc-agent", documentId: 42, fetch});
  await client.load();
  await client.insert(2, "!");
  await client.setCursor(0, 1);
  assert.ok(paths.includes("/api/documents/42/state"));
  assert.ok(paths.includes("/api/documents/42/updates"));
  assert.ok(paths.includes("/api/documents/42/cursor"));
  assert.throws(() => new AgentClient({agentId: "bad-doc", documentId: 0}), /documentId/);
});

test("AgentClient validates agent IDs and edit ranges", async () => {
  assert.throws(() => new AgentClient({agentId: "bad agent", documentId: 1}), /agentId/);
  const client = new AgentClient({agentId: "validation-agent", documentId: 1, fetch: makeFetch(new Y.Doc()).fetch});
  await assert.rejects(() => client.insert(0, "before load"), /Call load/);
  await client.load();
  await assert.rejects(() => client.delete(0, 1), /exceeds document length/);
});

test("AgentClient uploads files with raw bytes and returns metadata", async () => {
  const captured: {path: string; method?: string; contentType?: unknown; body?: unknown}[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    captured.push({
      path: url.pathname + "?" + [...url.searchParams].map(([k, v]) => `${k}=${v}`).join("&"),
      method: init?.method,
      contentType: (init?.headers as Record<string, string> | undefined)?.["content-type"],
      body: init?.body,
    });
    return new Response(
      JSON.stringify({id: 7, documentId: 11, checksum: "aa", filename: "dot.png", mimeType: "image/png", size: 3, uploadedBy: "img-agent", createdAt: "t", url: "/api/files/7", isImage: true}),
      {status: 201},
    );
  };
  const client = new AgentClient({agentId: "img-agent", documentId: 11, fetch});
  const bytes = new Uint8Array([1, 2, 3]);

  // Files are attached to a document.
  const image = await client.uploadImage(11, bytes, "image/png", "dot.png");
  assert.equal(image.url, "/api/files/7");
  assert.equal(image.isImage, true);
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].contentType, "image/png");
  assert.equal(captured[0].path, "/api/documents/11/files?uploadedBy=img-agent&filename=dot.png");
  assert.equal(captured[0].body, bytes); // raw bytes, not base64/JSON

  await client.uploadFile(11, bytes, "application/pdf", {filename: "report.pdf"});
  assert.equal(captured[1].path, "/api/documents/11/files?uploadedBy=img-agent&filename=report.pdf");
});

test("AgentClient lists and deletes files", async () => {
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/documents/1/files") {
      return new Response(JSON.stringify({files: [{id: 9, documentId: 1, checksum: "bb", filename: "a.pdf", mimeType: "application/pdf", size: 1, uploadedBy: null, createdAt: "t", url: "/api/files/9", isImage: false}]}));
    }
    return new Response(undefined, {status: 204});
  };
  const client = new AgentClient({agentId: "file-agent", documentId: 1, fetch});
  const files = await client.listFiles(1);
  assert.equal(files[0].filename, "a.pdf");
  await client.deleteFile(9);
  assert.deepEqual(calls, ["GET /api/documents/1/files", "DELETE /api/files/9"]);
});

const makeCommentFetch = (serverDoc: Y.Doc) => {
  const base = makeFetch(serverDoc);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/state")) {
      return new Response(
        JSON.stringify({update: encode(Y.encodeStateAsUpdate(serverDoc))}),
        {status: 200},
      );
    }
    return base.fetch(input, init);
  };
  return {fetch, serverDoc};
};

test("AgentClient adds, reads, replies to, updates, resolves, and deletes comments", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.getText("content").insert(0, "line one\nline two\nline three");
  const {fetch} = makeCommentFetch(serverDoc, 42);
  const client = new AgentClient({agentId: "commenter", documentId: 1, fetch});
  await client.load();

  const rootId = await client.addComment({line: 2, body: "look here"});
  const afterAdd = client.listComments();
  assert.equal(afterAdd.length, 1);
  assert.equal(afterAdd[0].id, rootId);
  assert.equal(afterAdd[0].author, "commenter");
  assert.equal(afterAdd[0].line, 2); // anchored to line 2
  assert.equal(afterAdd[0].anchor !== null, true);

  // The comment reached the server as an ordinary update on the shared Y.Doc.
  assert.equal(serverDoc.getArray("comments").length, 1);

  const replyId = await client.replyToComment(rootId, "agreed");
  const reply = client.listComments().find((c) => c.id === replyId)!;
  assert.equal(reply.parentId, rootId);
  assert.equal(reply.anchor, null);

  await client.updateComment(rootId, "edited");
  assert.equal(client.listComments().find((c) => c.id === rootId)!.body, "edited");

  await client.resolveComment(rootId);
  assert.equal(client.listComments().find((c) => c.id === rootId)!.resolved, true);

  // A root with a reply is tombstoned, not removed.
  await client.deleteComment(rootId);
  assert.equal(client.listComments().find((c) => c.id === rootId)!.body, "[deleted]");
  assert.equal(client.listComments().length, 2);

  // A leaf reply is removed outright.
  await client.deleteComment(replyId);
  assert.equal(client.listComments().length, 1);
});

test("AgentClient comment writes ride the update pipeline", async () => {
  const seen: (string | null)[] = [];
  const serverDoc = new Y.Doc();
  serverDoc.getText("content").insert(0, "hi");
  const base = makeCommentFetch(serverDoc);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/updates")) {
      seen.push((init?.headers as Record<string, string> | undefined)?.["x-agent-id"] ?? null);
    }
    return base.fetch(input, init);
  };
  const client = new AgentClient({agentId: "tok-commenter", documentId: 1, fetch});
  await client.load();
  await client.addComment({line: 1, body: "note"});
  assert.ok(seen.length > 0);
  assert.ok(seen.every((v) => v === "tok-commenter"));
});

test("AgentClient attributes comments to its own agentId", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.getText("content").insert(0, "hi");
  const {fetch} = makeCommentFetch(serverDoc);
  const client = new AgentClient({agentId: "anon-commenter", documentId: 1, fetch});
  await client.load();
  await client.addComment({line: 1, body: "note"});
  assert.equal(client.listComments()[0].author, "anon-commenter");
});

test("AgentClient exports its document, returning bytes + filename + warnings", async () => {
  const seen: {path: string; auth?: string}[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({path: url.pathname, agent: (init?.headers as Record<string, string> | undefined)?.["x-agent-id"]});
    if (url.pathname === "/api/documents/5/export") {
      return new Response("# Title\n\nbody", {status: 200, headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": 'attachment; filename="Title.md"',
        "x-export-warnings": encodeURIComponent("1 unreferenced attachment(s) were not included"),
      }});
    }
    return new Response(JSON.stringify({error: "not found"}), {status: 404});
  };
  const client = new AgentClient({agentId: "export-agent", documentId: 5, fetch});
  const result = await client.exportDocument();
  assert.equal(Buffer.from(result.bytes).toString("utf8"), "# Title\n\nbody");
  assert.equal(result.filename, "Title.md");
  assert.equal(result.contentType, "text/markdown; charset=utf-8");
  assert.deepEqual(result.warnings, ["1 unreferenced attachment(s) were not included"]);
  assert.deepEqual(seen, [{path: "/api/documents/5/export", agent: "export-agent"}]);
});

test("AgentClient imports Markdown text as a new document", async () => {
  const captured: {path: string; method?: string; contentType?: unknown; body?: unknown}[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    captured.push({
      path: url.pathname + url.search,
      method: init?.method,
      contentType: (init?.headers as Record<string, string> | undefined)?.["content-type"],
      body: init?.body,
    });
    return new Response(JSON.stringify({id: 12, folderId: 3, name: "notes.md"}), {status: 201});
  };
  const client = new AgentClient({agentId: "import-agent", documentId: 1, fetch});
  const doc = await client.importDocument(3, "# Imported\n\nbody", {filename: "notes.md"});
  assert.equal(doc.id, 12);
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].path, "/api/folders/3/import?filename=notes.md");
  assert.equal(captured[0].contentType, "text/markdown");
  assert.equal(captured[0].body, "# Imported\n\nbody"); // raw text, not JSON
});

test("AgentClient reads document history with paging params", async () => {
  const seen: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.pathname + url.search);
    return new Response(JSON.stringify({entries: [
      {id: "u2", revision: 2, author: {id: 7, kind: "human", displayName: "Alice"}, createdAt: "t2"},
      {id: "u1", revision: 1, author: {id: 9, kind: "agent", displayName: "bot"}, metadata: {reason: "x"}, createdAt: "t1"},
    ]}), {status: 200});
  };
  const client = new AgentClient({agentId: "hist-agent", documentId: 8, fetch});
  const entries = await client.history({limit: 2, before: "u3"});
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "u2");
  assert.equal(entries[0].author.displayName, "Alice");
  assert.equal(entries[1].metadata?.reason, "x");
  assert.equal(seen[0], "/api/documents/8/history?limit=2&before=u3");
});

test("AgentClient manages directory metadata", async () => {
  const calls: string[] = [];
  const directoryFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/folders" && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({folders: [{id: 1, parentFolderId: null, name: "Root"}]}));
    if (url.pathname === "/api/folders" && init?.method === "POST") return new Response(JSON.stringify({id: 2, parentFolderId: 1, name: "Research"}));
    if (url.pathname === "/api/folders/2" && init?.method === "PATCH") return new Response(JSON.stringify({id: 2, parentFolderId: 1, name: "Notes"}));
    if (url.pathname === "/api/folders/2/documents" && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({documents: []}));
    if (url.pathname === "/api/folders/2/documents" && init?.method === "POST") return new Response(JSON.stringify({id: 3, folderId: 2, name: "notes.md"}));
    if (url.pathname === "/api/documents/3" && init?.method === "PATCH") return new Response(JSON.stringify({id: 3, folderId: 1, name: "notes.md"}));
    return new Response(undefined, {status: 204});
  };
  const client = new AgentClient({agentId: "directory-agent", documentId: 1, fetch: directoryFetch});
  const root = (await client.listFolders())[0];
  const folder = await client.createFolder("Research", root.id);
  await client.renameFolder(folder.id, "Notes");
  assert.deepEqual(await client.listDocuments(folder.id), []);
  const document = await client.createDocument(folder.id, "notes.md");
  await client.moveDocument(document.id, root.id);
  await client.deleteFolder(folder.id);
  assert.deepEqual(calls, [
    "GET /api/folders",
    "POST /api/folders",
    "PATCH /api/folders/2",
    "GET /api/folders/2/documents",
    "POST /api/folders/2/documents",
    "PATCH /api/documents/3",
    "DELETE /api/folders/2",
  ]);
});
