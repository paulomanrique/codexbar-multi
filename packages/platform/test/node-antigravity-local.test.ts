import { createServer } from "node:http";
import { once } from "node:events";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  classifyNodeAntigravityProcess,
  extractNodeAntigravityFlag,
  fetchNodeAntigravityLocalSnapshot,
  makeNodeAntigravityLocalDependencies,
  nodeAntigravityConnectionCandidates,
  nodeAntigravitySocketInode,
  parseNodeAntigravityProcNetPorts,
  parseNodeAntigravityWindowsProcesses,
  requestNodeAntigravityLocalJSON,
  resolveNodeAntigravityProcesses,
  type NodeAntigravityEndpoint,
  type NodeAntigravityLocalDependencies,
  type NodeAntigravityProcess,
} from "../src/node-antigravity-local.ts";

const app = (
  pid: number,
  extra = "--csrf_token app-token --app_data_dir antigravity",
): NodeAntigravityProcess => ({
  pid,
  command: `/Applications/Antigravity.app/Contents/Resources/bin/language_server ${extra}`,
});

describe("Node Antigravity local broker", () => {
  it("ports the Swift process classifier, Gemini rename, CLI anchors and token policy", () => {
    const ide = {
      pid: 2,
      command:
        "/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm " +
        "--csrf_token ide-token --app_data_dir=antigravity-ide",
    };
    expect(classifyNodeAntigravityProcess(app(1))).toBe("app");
    expect(classifyNodeAntigravityProcess(ide)).toBe("ide");
    expect(
      classifyNodeAntigravityProcess({
        pid: 3,
        command:
          "/Applications/Gemini.app/Contents/Resources/bin/language-server --csrf_token renamed",
      }),
    ).toBe("app");
    expect(classifyNodeAntigravityProcess({ pid: 4, command: "/usr/local/bin/agy -p hi" })).toBe(
      "cli",
    );
    expect(classifyNodeAntigravityProcess({ pid: 7, command: "C:\\Tools\\agy.exe -p hi" })).toBe(
      "cli",
    );
    expect(
      classifyNodeAntigravityProcess({ pid: 5, command: "/usr/bin/legacy --workspace agy" }),
    ).toBeUndefined();

    const resolved = resolveNodeAntigravityProcesses([
      app(6, "--app_data_dir antigravity"),
      ide,
      { pid: 4, command: "/usr/local/bin/agy -p hi" },
      app(
        1,
        "--csrf_token=app-token --extension_server_port 64123 " +
          "--extension_server_csrf_token extension-token --app_data_dir antigravity",
      ),
    ]);
    expect(resolved.map(({ pid, kind }) => ({ pid, kind }))).toEqual([
      { pid: 1, kind: "app" },
      { pid: 4, kind: "cli" },
      { pid: 2, kind: "ide" },
    ]);
    expect(resolved[0]).toMatchObject({
      csrfToken: "app-token",
      extensionPort: 64123,
      extensionServerCSRFToken: "extension-token",
    });
    expect(extractNodeAntigravityFlag("binary --csrf_token token", "--csrf_token")).toBe("token");
  });

  it("parses only LISTEN ports owned by the process socket inodes", () => {
    expect(nodeAntigravitySocketInode("socket:[12345]")).toBe("12345");
    expect(nodeAntigravitySocketInode("pipe:[12345]")).toBeUndefined();
    const table = `
      sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode
       0: 0100007F:1F90 00000000:0000 0A 0:0 00:0 0 1000 0 12345
       1: 0100007F:2382 00000000:0000 01 0:0 00:0 0 1000 0 12345
       2: 0100007F:2710 00000000:0000 0A 0:0 00:0 0 1000 0 99999
    `;
    expect(parseNodeAntigravityProcNetPorts(table, new Set(["12345"]))).toEqual([8080]);
  });

  it("builds Swift-compatible endpoint order without duplicating extension credentials", () => {
    const process = resolveNodeAntigravityProcesses([
      app(
        1,
        "--csrf_token language --extension_server_port=64123 " +
          "--extension_server_csrf_token=extension --app_data_dir antigravity",
      ),
    ])[0]!;
    expect(nodeAntigravityConnectionCandidates(process, [50000], "linux")).toEqual([
      {
        scheme: "https",
        port: 50000,
        csrfToken: "language",
        source: "language-server",
      },
      {
        scheme: "http",
        port: 50000,
        csrfToken: "language",
        source: "language-server",
      },
      {
        scheme: "http",
        port: 64123,
        csrfToken: "extension",
        source: "extension-server",
      },
      {
        scheme: "http",
        port: 64123,
        csrfToken: "language",
        source: "extension-server",
      },
    ]);
    const sameToken = resolveNodeAntigravityProcesses([
      app(
        2,
        "--csrf_token=same --extension_server_port=50000 " +
          "--extension_server_csrf_token=same --app_data_dir antigravity",
      ),
    ])[0]!;
    expect(nodeAntigravityConnectionCandidates(sameToken, [50000], "linux")).toHaveLength(2);
  });

  it("queries quota first, treats identity as best effort, and never returns process credentials", async () => {
    const calls: Array<{ readonly path: string; readonly token: string }> = [];
    const dependencies: NodeAntigravityLocalDependencies = {
      processes: async () => [app(10)],
      listeningPorts: async () => [64123],
      request: async (endpoint, path) => {
        calls.push({ path, token: endpoint.csrfToken });
        if (path.endsWith("GetUserStatus")) throw new Error("identity unavailable");
        return '{"groups":[{"displayName":"Gemini","buckets":[]}]}';
      },
    };
    await expect(
      fetchNodeAntigravityLocalSnapshot(dependencies, {
        signal: new AbortController().signal,
        platform: "darwin",
      }),
    ).resolves.toEqual({
      quotaSummaryJson: '{"groups":[{"displayName":"Gemini","buckets":[]}]}',
    });
    expect(calls.map((call) => call.path)).toEqual([
      "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
      "/exa.language_server_pb.LanguageServerService/GetUserStatus",
    ]);
    expect(JSON.stringify(await Promise.resolve(calls))).toContain("app-token");
    expect(
      JSON.stringify(
        await fetchNodeAntigravityLocalSnapshot(
          {
            ...dependencies,
            request: async (_endpoint, path) =>
              path.endsWith("GetUserStatus") ? '{"userStatus":{"email":"a@test"}}' : "{}",
          },
          { signal: new AbortController().signal, platform: "darwin" },
        ),
      ),
    ).not.toContain("app-token");
  });

  it("propagates cancellation and never advances to another endpoint", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pending = fetchNodeAntigravityLocalSnapshot(
      {
        processes: async () => [app(1)],
        listeningPorts: async () => [64123, 64124],
        request: async (_endpoint, _path, _body, _timeout, signal) => {
          attempts += 1;
          controller.abort(new DOMException("cancelled", "AbortError"));
          throw signal.reason;
        },
      },
      { signal: controller.signal, platform: "darwin" },
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });

  it("retries best-effort identity on the remaining resolved endpoints", async () => {
    const identityPorts: number[] = [];
    const result = await fetchNodeAntigravityLocalSnapshot(
      {
        processes: async () => [app(1)],
        listeningPorts: async () => [64123, 64124],
        request: async (endpoint, path) => {
          if (path.endsWith("RetrieveUserQuotaSummary")) return '{"groups":[]}';
          identityPorts.push(endpoint.port);
          if (endpoint.port === 64123) throw new Error("stale endpoint");
          return '{"userStatus":{"email":"fixture@example.test"}}';
        },
      },
      { signal: new AbortController().signal, platform: "darwin" },
    );
    expect(result.userStatusJson).toContain("fixture@example.test");
    expect(identityPorts).toEqual([64123, 64124]);
  });

  it("never attaches identity from a different process to a completed quota", async () => {
    const quotaPids: number[] = [];
    const identityPorts: number[] = [];
    const result = await fetchNodeAntigravityLocalSnapshot(
      {
        processes: async () => [
          app(1, "--csrf_token first --app_data_dir antigravity"),
          app(2, "--csrf_token second --app_data_dir antigravity"),
        ],
        listeningPorts: async (pid) => {
          quotaPids.push(pid);
          return [64_000 + pid];
        },
        request: async (endpoint, path) => {
          if (path.endsWith("RetrieveUserQuotaSummary")) return '{"groups":[]}';
          identityPorts.push(endpoint.port);
          if (endpoint.port === 64_001) throw new Error("first process has no identity");
          return '{"userStatus":{"email":"wrong-account@example.test"}}';
        },
      },
      { signal: new AbortController().signal, platform: "darwin" },
    );
    expect(quotaPids).toEqual([1, 2]);
    expect(identityPorts).toEqual([64_001]);
    expect(result).not.toHaveProperty("userStatusJson");
  });

  it("preserves completed quota when only best-effort identity reaches the internal deadline", async () => {
    const result = await fetchNodeAntigravityLocalSnapshot(
      {
        processes: async () => [app(1)],
        listeningPorts: async () => [64123],
        request: async (_endpoint, path, _body, _timeout, signal) => {
          if (path.endsWith("RetrieveUserQuotaSummary")) return '{"groups":[]}';
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
          throw new Error("unreachable");
        },
      },
      { signal: new AbortController().signal, platform: "darwin", timeoutMs: 10 },
    );
    expect(result).toEqual({ quotaSummaryJson: '{"groups":[]}' });
  });

  it("does not start a request after the injected monotonic deadline has expired", async () => {
    let requests = 0;
    const values = [0, 11];
    await expect(
      fetchNodeAntigravityLocalSnapshot(
        {
          now: () => values.shift() ?? 11,
          processes: async () => [app(1)],
          listeningPorts: async () => [64123],
          request: async () => {
            requests += 1;
            return "{}";
          },
        },
        { signal: new AbortController().signal, platform: "darwin", timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({
      code: "request-failed",
      message: expect.stringContaining("timed out"),
    });
    expect(requests).toBe(0);
  });

  it("uses fixed Windows process commands and rejects malformed process JSON", async () => {
    const calls: unknown[] = [];
    const dependencies = makeNodeAntigravityLocalDependencies({
      platform: "win32",
      environment: { SYSTEMROOT: "C:\\Windows" },
      processRunner: {
        run: (spec) => {
          calls.push(spec);
          return Effect.succeed({
            exitCode: 0,
            signal: undefined,
            stdout: new TextEncoder().encode(
              '[{"ProcessId":7,"CommandLine":"C:\\\\Antigravity\\\\language_server.exe --csrf_token t"}]',
            ),
            stderr: new Uint8Array(),
          });
        },
      },
    });
    await expect(dependencies.processes(new AbortController().signal)).resolves.toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
    });
    expect(parseNodeAntigravityWindowsProcesses("[]")).toEqual([]);
    expect(() => parseNodeAntigravityWindowsProcesses("not-json")).toThrow();
  });

  it("pins requests to loopback, sends exact headers, and bounds the response", async () => {
    const seen: Array<{
      readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
      readonly body: string;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
        response.setHeader("Content-Type", "application/json");
        response.end('{"ok":true}');
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const endpoint: NodeAntigravityEndpoint = {
        scheme: "http",
        port: address.port,
        csrfToken: "fixture-token",
        source: "language-server",
      };
      await expect(
        requestNodeAntigravityLocalJSON(
          endpoint,
          "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
          { forceRefresh: true },
          1_000,
          new AbortController().signal,
        ),
      ).resolves.toBe('{"ok":true}');
      expect(seen[0]).toMatchObject({
        headers: {
          host: `127.0.0.1:${address.port}`,
          "content-type": "application/json",
          "connect-protocol-version": "1",
          "x-codeium-csrf-token": "fixture-token",
        },
        body: '{"forceRefresh":true}',
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("rejects an oversized loopback response from Content-Length before retaining its body", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Length", String(1024 * 1024 + 1));
      response.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      await expect(
        requestNodeAntigravityLocalJSON(
          {
            scheme: "http",
            port: address.port,
            csrfToken: "fixture-token",
            source: "language-server",
          },
          "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
          { forceRefresh: true },
          1_000,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "invalid-response" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("rejects an already-aborted request without opening a socket", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      requestNodeAntigravityLocalJSON(
        { scheme: "http", port: 64123, csrfToken: "fixture", source: "language-server" },
        "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
        { forceRefresh: true },
        1_000,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
