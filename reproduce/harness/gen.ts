// Deterministic example values from a tool's own JSON Schema (Draft 2020-12, `#/$defs` references).
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = Record<string, any>;

export interface Profile {
  /** The text used for a string with no format, pattern or enum. */
  readonly text: string;
  /** Which branch of every oneOf/anyOf to take, modulo its length. */
  readonly branch: number;
  /** Include optional properties up to this depth (parameter groups are depth 1). */
  readonly optionalDepth: number;
}

const formats: Record<string, string> = {
  "date-time": "2026-01-02T03:04:05Z",
  date: "2026-01-02",
  time: "03:04:05Z",
  email: "user@example.com",
  uri: "https://example.com/item",
  url: "https://example.com/item",
  "uri-reference": "https://example.com/item",
  uuid: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
  hostname: "example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
  byte: "aGVsbG8=",
  binary: "aGVsbG8=",
  password: "secret-value",
  "phone-number": "+15555550100",
};
const candidates = [
  "abc", "ABC", "abc123", "ABC123", "a1", "123", "1", "abc-123", "abc_def", "2026-01-02",
  "2026-01-02T03:04:05Z", "user@example.com", "https://example.com/item", "US", "us", "usd",
  "USD", "en", "en-US", "#ffffff", "ffffff", "+15555550100", "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
  "a", "A", "0", "abc.def", "aGVsbG8=", "AB12CD34",
];

export function generator(definitions: Record<string, Node>, profile: Profile) {
  const resolve = (schema: Node, root: Node): Node => {
    // Boolean and malformed schemas constrain nothing a generator can use.
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return {};
    let current = schema;
    for (let hops = 0; typeof current?.$ref === "string" && hops < 20; hops++) {
      const parts = current.$ref.replace(/^#\//, "").split("/").map(decodePointer);
      if (parts[0] !== "$defs") return {};
      let target: any = root.$defs?.[parts[1] ?? ""] ?? definitions[parts[1] ?? ""];
      for (const part of parts.slice(2)) target = target?.[part];
      const { $ref: _, ...siblings } = current;
      current = { ...(target ?? {}), ...siblings };
    }
    return current !== null && typeof current === "object" ? current : {};
  };

  const merge = (schema: Node, root: Node): Node => {
    if (!Array.isArray(schema.allOf)) return schema;
    const { allOf, ...rest } = schema;
    let merged: Node = { ...rest };
    for (const part of allOf) {
      const p = merge(resolve(part, root), root);
      merged = {
        ...p,
        ...merged,
        properties: { ...p.properties, ...merged.properties },
        required: [...(p.required ?? []), ...(merged.required ?? [])],
      };
    }
    return merged;
  };

  const string = (s: Node, index: number): string => {
    const min = s.minLength ?? 0;
    const max = s.maxLength ?? Infinity;
    const fits = (v: string) => v.length >= min && v.length <= max;
    if (typeof s.pattern === "string") {
      let pattern: RegExp;
      try {
        pattern = new RegExp(s.pattern, "u");
      } catch {
        return "abc";
      }
      const examples = [...(s.examples ?? []), s.default].filter((v) => typeof v === "string");
      return [...examples, ...candidates].find((v) => pattern.test(v) && fits(v)) ?? "abc";
    }
    if (s.contentEncoding === "base64") return "aGVsbG8=";
    const formatted = s.format === undefined ? undefined : formats[s.format];
    if (formatted !== undefined) return formatted;
    let text = index === 0 ? profile.text : `${profile.text}${index}`;
    if (text.length < min) text = text.padEnd(min, "x");
    return text.slice(0, max === Infinity ? undefined : max);
  };

  const number = (s: Node, integer: boolean): number => {
    let value = 2;
    if (typeof s.minimum === "number") value = Math.max(value, s.minimum);
    if (typeof s.exclusiveMinimum === "number") value = Math.max(value, s.exclusiveMinimum + 1);
    if (typeof s.maximum === "number") value = Math.min(value, s.maximum);
    if (typeof s.exclusiveMaximum === "number")
      value = Math.min(value, s.exclusiveMaximum - (integer ? 1 : 0.5));
    if (typeof s.multipleOf === "number" && s.multipleOf > 0)
      value = Math.ceil(value / s.multipleOf) * s.multipleOf;
    return integer ? Math.ceil(value) : value;
  };

  const pickType = (s: Node): string | undefined => {
    const types = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
    const real = types.filter((t: string) => t !== "null");
    if (real.length) return real[0];
    if (types.includes("null")) return "null";
    if (s.properties !== undefined || s.additionalProperties !== undefined) return "object";
    if (s.items !== undefined || s.prefixItems !== undefined) return "array";
    return undefined;
  };

  const value = (schema: Node, root: Node, depth: number, index = 0): Json => {
    const s = merge(resolve(schema, root), root);
    if (depth > 12) return null;
    if ("const" in s) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) {
      const options = s.enum.filter((v: Json) => v !== null);
      return options.length ? options[index % options.length] : null;
    }
    const branches = s.oneOf ?? s.anyOf;
    if (Array.isArray(branches) && branches.length) {
      const { oneOf: _, anyOf: __, ...rest } = s;
      const chosen = merge(resolve(branches[profile.branch % branches.length], root), root);
      return value(
        {
          ...rest,
          ...chosen,
          properties: { ...rest.properties, ...chosen.properties },
          required: [...(rest.required ?? []), ...(chosen.required ?? [])],
        },
        root,
        depth,
        index,
      );
    }
    switch (pickType(s)) {
      case "string":
        return string(s, index);
      case "integer":
        return number(s, true);
      case "number":
        return number(s, false);
      case "boolean":
        return true;
      case "null":
        return null;
      case "array":
        return array(s, root, depth);
      case "object":
        return object(s, root, depth);
      default:
        return s.properties === undefined ? profile.text : object(s, root, depth);
    }
  };

  const array = (s: Node, root: Node, depth: number): Json[] => {
    const count = Math.min(Math.max(s.minItems ?? 2, 1), s.maxItems ?? 2);
    const prefix: Node[] = Array.isArray(s.prefixItems) ? s.prefixItems : [];
    return Array.from({ length: Math.max(count, prefix.length) }, (_, i) =>
      value(prefix[i] ?? s.items ?? {}, root, depth + 1, i),
    );
  };

  const object = (s: Node, root: Node, depth: number): Json => {
    const required = new Set<string>(s.required ?? []);
    const result: Record<string, Json> = {};
    for (const [key, property] of Object.entries<Node>(s.properties ?? {})) {
      if (required.has(key) || depth < profile.optionalDepth)
        result[key] = value(property, root, depth + 1);
    }
    for (const key of required)
      if (!(key in result) && s.additionalProperties !== false)
        result[key] = typeof s.additionalProperties === "object"
          ? value(s.additionalProperties, root, depth + 1)
          : profile.text;
    return result;
  };

  /** A tool input: parameter groups, then the body variant this profile's branch selects. */
  return (input: Node): Json => {
    const result: Record<string, Json> = {};
    const required = new Set<string>(input.required ?? []);
    for (const group of ["path", "query", "headers", "cookie"]) {
      const shape = input.properties?.[group];
      if (shape === undefined) continue;
      const generated = object(shape, input, profile.optionalDepth > 0 ? 0 : 1) as Record<string, Json>;
      if (required.has(group) || Object.keys(generated).length) result[group] = generated;
    }
    const variants: Node[] = input.anyOf ?? [];
    if (variants.length) {
      const variant = variants[profile.branch % variants.length] ?? {};
      const contentType = variant.properties?.contentType?.enum?.[0];
      const bodyWanted = required.has("body") || profile.optionalDepth > 0;
      if (bodyWanted) {
        result.body = value(variant.properties?.body ?? {}, input, 1);
        if (typeof contentType === "string") result.contentType = contentType;
      }
    }
    return result;
  };
}

const decodePointer = (token: string) => token.replaceAll("~1", "/").replaceAll("~0", "~");
