import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveRepoLanguages } from "../../dist/mcp/tools/repo.js";
import { RepoRegisterRequestSchema } from "../../dist/mcp/tools.js";
import { RepoGatewaySchema } from "../../dist/gateway/schemas.js";
import { LanguageSchema } from "../../dist/config/types.js";
import { zodSchemaToJsonSchema } from "../../dist/gateway/compact-schema.js";

describe("repo.register language defaults", () => {
  it("defaults to all supported languages when languages are omitted", () => {
    const languages = resolveRepoLanguages(undefined);

    assert.ok(languages.includes("ts"));
    assert.ok(languages.includes("py"));
    assert.ok(languages.includes("go"));
    assert.ok(languages.includes("java"));
    assert.ok(languages.includes("cs"));
    assert.ok(languages.includes("c"));
    assert.ok(languages.includes("cpp"));
    assert.ok(languages.includes("rs"));
    assert.ok(languages.includes("kt"));
    assert.equal(languages.includes("php"), false);
    assert.equal(languages.includes("sh"), false);
    assert.equal(languages.includes("powershell"), false);
    assert.equal(languages.includes("ruby"), false);
    assert.equal(languages.includes("lua"), false);
    assert.equal(languages.includes("dart"), false);
    assert.equal(languages.includes("swift"), false);
    assert.equal(languages.includes("groovy"), false);
    assert.equal(languages.includes("perl"), false);
    assert.equal(languages.includes("r"), false);
    assert.equal(languages.includes("elixir"), false);
    assert.equal(languages.includes("fsharp"), false);
    assert.equal(languages.includes("fortran"), false);
    assert.equal(languages.includes("haskell"), false);
    assert.equal(languages.includes("julia"), false);
    assert.equal(languages.includes("nix"), false);
    assert.equal(languages.includes("clojure"), false);
    assert.equal(languages.includes("ocaml"), false);
    assert.equal(languages.includes("d"), false);
    assert.equal(languages.includes("haxe"), false);
    assert.equal(languages.includes("commonlisp"), false);
    assert.equal(languages.includes("gleam"), false);
    assert.equal(languages.includes("zig"), false);
  });

  it("accepts canonical language keys on direct and gateway registrations", () => {
    const languages = ["ts", "py", "powershell"];

    assert.deepStrictEqual(
      RepoRegisterRequestSchema.parse({
        repoId: "direct-repo",
        rootPath: "C:/repos/direct",
        languages,
      }).languages,
      languages,
    );
    assert.deepStrictEqual(
      RepoGatewaySchema.parse({
        repoId: "gateway-repo",
        action: "repo.register",
        rootPath: "C:/repos/gateway",
        languages,
      }).languages,
      languages,
    );
  });

  it("rejects non-canonical language aliases before registration dispatch", () => {
    const direct = RepoRegisterRequestSchema.safeParse({
      repoId: "direct-repo",
      rootPath: "C:/repos/direct",
      languages: ["typescript"],
    });
    const gateway = RepoGatewaySchema.safeParse({
      repoId: "gateway-repo",
      action: "repo.register",
      rootPath: "C:/repos/gateway",
      languages: ["typescript"],
    });

    assert.strictEqual(direct.success, false);
    assert.strictEqual(gateway.success, false);
  });

  it("publishes the canonical enum and omitted-value guidance", () => {
    const jsonSchema = zodSchemaToJsonSchema(RepoRegisterRequestSchema) as {
      properties?: {
        languages?: {
          description?: string;
          items?: { enum?: string[] };
        };
      };
    };
    const languages = jsonSchema.properties?.languages;

    assert.deepStrictEqual(languages?.items?.enum, LanguageSchema.options);
    assert.match(languages?.description ?? "", /SDL language\/extension keys/i);
    assert.match(languages?.description ?? "", /omit/i);
  });
});
