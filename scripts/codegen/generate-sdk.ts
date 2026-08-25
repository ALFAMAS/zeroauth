/**
 * Auto-generate the `@zerotrust/client` TypeScript SDK from the OpenAPI spec.
 *
 *   bun run sdk:generate
 *
 * Reads `src/api/openapi.json` and emits a single, dependency-free
 * `packages/client/src/index.ts` containing:
 *   - interfaces/types for every `components.schemas` entry,
 *   - a `zerotrustError` runtime error,
 *   - a `zerotrustClient` class with one typed method per OpenAPI operation.
 *
 * The generated client targets the global `fetch` (Node 18+, Bun, browsers) and
 * has zero runtime dependencies. The core string-building functions are exported
 * so they can be unit-tested without touching the filesystem.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── OpenAPI types (the slice we consume) ──────────────────────────────────────

export interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: (string | number)[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  description?: string;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}

export interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: OpenApiSchema }>;
    }
  >;
  security?: Record<string, string[]>[];
}

export interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string; description?: string }[];
  components?: { schemas?: Record<string, OpenApiSchema> };
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

// ── String helpers ────────────────────────────────────────────────────────────

function camelCase(input: string): string {
  const parts = input
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/);
  return parts
    .map((p, i) =>
      i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)
    )
    .join("");
}

/** A bare object key when it's a valid identifier, otherwise a quoted key. */
function safeKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function refName(ref: string): string {
  return ref.split("/").pop() ?? "unknown";
}

// ── Schema → TypeScript type ──────────────────────────────────────────────────

/** Render an OpenAPI schema as a TypeScript type expression. */
export function tsTypeForSchema(schema: OpenApiSchema | undefined): string {
  if (!schema) return "unknown";
  if (schema.$ref) return refName(schema.$ref);

  if (schema.allOf?.length) {
    return schema.allOf.map(tsTypeForSchema).join(" & ");
  }
  if (schema.oneOf?.length) return schema.oneOf.map(tsTypeForSchema).join(" | ");
  if (schema.anyOf?.length) return schema.anyOf.map(tsTypeForSchema).join(" | ");

  if (schema.enum?.length) {
    return schema.enum
      .map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
      .join(" | ");
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = types.includes("null");
  const primary = types.find((t) => t !== "null");

  let base: string;
  switch (primary) {
    case "string":
      base = "string";
      break;
    case "integer":
    case "number":
      base = "number";
      break;
    case "boolean":
      base = "boolean";
      break;
    case "array":
      base = `${tsTypeForSchema(schema.items)}[]`;
      break;
    case "object":
    case undefined:
      base = objectType(schema);
      break;
    default:
      base = "unknown";
  }
  return nullable && base !== "unknown" ? `${base} | null` : base;
}

function objectType(schema: OpenApiSchema): string {
  const props = schema.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length === 0) {
    // Free-form object.
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      return `Record<string, ${tsTypeForSchema(schema.additionalProperties)}>`;
    }
    return "Record<string, unknown>";
  }
  const required = new Set(schema.required ?? []);
  const fields = keys
    .map((k) => {
      const optional = required.has(k) ? "" : "?";
      return `${safeKey(k)}${optional}: ${tsTypeForSchema(props[k])}`;
    })
    .join("; ");
  return `{ ${fields} }`;
}

/** Emit the top-level `export interface`/`export type` block for one named schema. */
export function emitSchemaDeclaration(name: string, schema: OpenApiSchema): string {
  const doc = schema.description ? `/** ${schema.description} */\n` : "";
  const isObject =
    (schema.type === "object" || (!schema.type && schema.properties)) &&
    !schema.enum &&
    !schema.oneOf &&
    !schema.anyOf &&
    !schema.allOf;

  if (isObject && schema.properties && Object.keys(schema.properties).length > 0) {
    const required = new Set(schema.required ?? []);
    const body = Object.entries(schema.properties)
      .map(([k, v]) => {
        const d = v.description ? `  /** ${v.description} */\n` : "";
        const optional = required.has(k) ? "" : "?";
        return `${d}  ${safeKey(k)}${optional}: ${tsTypeForSchema(v)};`;
      })
      .join("\n");
    return `${doc}export interface ${name} {\n${body}\n}`;
  }
  return `${doc}export type ${name} = ${tsTypeForSchema(schema)};`;
}

// ── Operation → method ────────────────────────────────────────────────────────

/** Deterministic, unique-ish method name for a `METHOD /path` operation. */
export function operationMethodName(method: string, route: string): string {
  const segments = route
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith("{") ? `by ${seg.slice(1, -1)}` : seg));
  return camelCase(`${method} ${segments.join(" ")}`);
}

/** Pick the response schema of the first 2xx JSON response, if any. */
function successSchema(op: OpenApiOperation): OpenApiSchema | undefined {
  const responses = op.responses ?? {};
  for (const code of Object.keys(responses)) {
    if (/^2\d\d$/.test(code)) {
      const schema = responses[code]?.content?.["application/json"]?.schema;
      if (schema) return schema;
    }
  }
  return undefined;
}

function requestBodySchema(op: OpenApiOperation): OpenApiSchema | undefined {
  return op.requestBody?.content?.["application/json"]?.schema;
}

interface BuiltMethod {
  name: string;
  code: string;
}

function buildMethod(
  method: HttpMethod,
  route: string,
  op: OpenApiOperation,
  usedNames: Set<string>
): BuiltMethod {
  let name = op.operationId ? camelCase(op.operationId) : operationMethodName(method, route);
  // Guarantee uniqueness across the client.
  if (usedNames.has(name)) {
    let i = 2;
    while (usedNames.has(`${name}${i}`)) i++;
    name = `${name}${i}`;
  }
  usedNames.add(name);

  const params = op.parameters ?? [];
  const pathParams = params.filter((p) => p.in === "path");
  const queryParams = params.filter((p) => p.in === "query");
  const bodySchema = requestBodySchema(op);
  const returnType = tsTypeForSchema(successSchema(op)) || "unknown";

  // Signature args: required path params, then body, then optional query bag.
  const args: string[] = [];
  for (const p of pathParams) {
    args.push(`${camelCase(p.name)}: ${tsTypeForSchema(p.schema)}`);
  }
  if (bodySchema) {
    const optional = op.requestBody?.required ? "" : "?";
    args.push(`body${optional}: ${tsTypeForSchema(bodySchema)}`);
  }
  if (queryParams.length > 0) {
    const anyRequired = queryParams.some((p) => p.required);
    const fields = queryParams
      .map((p) => `${safeKey(p.name)}${p.required ? "" : "?"}: ${tsTypeForSchema(p.schema)}`)
      .join("; ");
    args.push(`query${anyRequired ? "" : "?"}: { ${fields} }`);
  }

  // URL template with encoded path params.
  const urlTemplate = route.replace(
    /\{([^}]+)}/g,
    (_m, raw) => `\${encodeURIComponent(${camelCase(raw)})}`
  );

  // request() options object.
  const opts: string[] = [];
  if (queryParams.length > 0) opts.push("query");
  if (bodySchema) opts.push("body");
  const optsArg = opts.length > 0 ? `, { ${opts.join(", ")} }` : "";

  // JSDoc.
  const docLines: string[] = [];
  if (op.summary) docLines.push(op.summary);
  if (op.description && op.description !== op.summary) docLines.push("", op.description);
  docLines.push("", `@route ${method.toUpperCase()} ${route}`);
  for (const p of pathParams)
    docLines.push(`@param ${camelCase(p.name)} ${p.description ?? "path parameter"}`);
  const doc = `  /**\n${docLines.map((l) => `   *${l ? ` ${l}` : ""}`).join("\n")}\n   */\n`;

  const code =
    `${doc}  ${name}(${args.join(", ")}): Promise<${returnType}> {\n` +
    `    return this.request("${method.toUpperCase()}", \`${urlTemplate}\`${optsArg});\n` +
    `  }`;
  return { name, code };
}

// ── Full SDK assembly ─────────────────────────────────────────────────────────

const RUNTIME_PREAMBLE = `/**
 * Options for constructing a {@link zerotrustClient}.
 */
export interface zerotrustClientOptions {
  /** API base URL, e.g. "https://api.zerotrust.app". Defaults to the spec server. */
  baseUrl?: string;
  /** Bearer token (PASETO) sent as the Authorization header on every request. */
  token?: string;
  /** Custom fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

export interface zerotrustRequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Thrown for any non-2xx response. Carries the HTTP status and parsed body. */
export class zerotrustError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "zerotrustError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}`;

function clientClass(spec: OpenApiSpec, methods: BuiltMethod[]): string {
  const defaultBase = spec.servers?.[0]?.url ?? "";
  const methodBlocks = methods.map((m) => m.code).join("\n\n");
  return `/**
 * Typed client for the ${spec.info?.title ?? "zerotrust API"} (v${spec.info?.version ?? "1.0.0"}).
 * Auto-generated — do not edit by hand. Regenerate with \`bun run sdk:generate\`.
 */
export class zerotrustClient {
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private defaultHeaders: Record<string, string>;
  token?: string;

  constructor(options: zerotrustClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ${JSON.stringify(defaultBase)}).replace(/\\/+$/, "");
    this.token = options.token;
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new Error("No fetch implementation available; pass options.fetch");
    this.fetchImpl = f.bind(globalThis);
    this.defaultHeaders = options.headers ?? {};
  }

  /** Update the bearer token used for subsequent requests. */
  setToken(token: string | undefined): void {
    this.token = token;
  }

  /** Low-level request helper used by every generated method. */
  async request<T>(method: string, path: string, options: zerotrustRequestOptions = {}): Promise<T> {
    let url = this.baseUrl + path;
    if (options.query) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null) sp.append(k, String(v));
      }
      const qs = sp.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }

    const headers: Record<string, string> = { ...this.defaultHeaders, ...options.headers };
    if (this.token) headers.Authorization = \`Bearer \${this.token}\`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      body = JSON.stringify(options.body);
    }

    const res = await this.fetchImpl(url, { method, headers, body });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const env = parsed as { code?: string; message?: string; error?: string; details?: unknown } | undefined;
      throw new zerotrustError(
        env?.message ?? env?.error ?? \`Request failed with status \${res.status}\`,
        res.status,
        env?.code ?? env?.error,
        env?.details ?? parsed,
      );
    }
    return parsed as T;
  }

${methodBlocks}
}`;
}

/** Generate the full `index.ts` source for the SDK from an OpenAPI spec. */
export function generateSdk(spec: OpenApiSpec): string {
  const schemas = spec.components?.schemas ?? {};
  // Use the exact schema key as the type name — $ref resolution depends on it.
  const typeBlocks = Object.entries(schemas).map(([name, schema]) =>
    emitSchemaDeclaration(name, schema)
  );

  const usedNames = new Set<string>(["request", "setToken", "constructor", "token"]);
  const methods: BuiltMethod[] = [];
  for (const [route, ops] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = ops[method];
      if (op) methods.push(buildMethod(method, route, op, usedNames));
    }
  }

  const header = `/* eslint-disable */
// ─────────────────────────────────────────────────────────────────────────────
// @zerotrust/client — AUTO-GENERATED from src/api/openapi.json. DO NOT EDIT.
// Regenerate with \`bun run sdk:generate\`.
// ${spec.info?.title ?? "zerotrust API"} v${spec.info?.version ?? "1.0.0"}
// ─────────────────────────────────────────────────────────────────────────────`;

  return [
    header,
    "",
    "// ── Schema types ──",
    typeBlocks.join("\n\n"),
    "",
    "// ── Runtime ──",
    RUNTIME_PREAMBLE,
    "",
    "// ── Client ──",
    clientClass(spec, methods),
    "",
  ].join("\n");
}

// ── CLI entry point ───────────────────────────────────────────────────────────

export function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const specPath = path.join(repoRoot, "src", "api", "openapi.json");
  const outDir = path.join(repoRoot, "packages", "client", "src");
  const outFile = path.join(outDir, "index.ts");

  const spec = JSON.parse(readFileSync(specPath, "utf8")) as OpenApiSpec;
  const source = generateSdk(spec);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, source, "utf8");

  const methodCount = Object.values(spec.paths ?? {}).reduce(
    (n, ops) => n + HTTP_METHODS.filter((m) => ops[m]).length,
    0
  );
  const schemaCount = Object.keys(spec.components?.schemas ?? {}).length;
  // biome-ignore lint/suspicious/noConsole: CLI progress output for the generator
  console.log(
    `✓ Generated @zerotrust/client → ${path.relative(repoRoot, outFile)} (${methodCount} operations, ${schemaCount} schemas)`
  );
}

// Run only when invoked directly (not when imported by the test suite).
if (process.argv[1] && /generate-sdk\.(ts|js|mjs|cjs)$/.test(process.argv[1])) {
  main();
}
